/**
 * Slack incoming-webhook emitter for T3 / T4 escalation.
 *
 * Multi-channel webhook routing — the aggregator picks a target channel based
 * on file paths (`#payments-review` vs `#security` vs `#eng-reviews`). This
 * emitter then resolves the channel to the matching webhook URL via env:
 *
 *   SLACK_WEBHOOK_PAYMENTS     → bound to #payments-review
 *   SLACK_WEBHOOK_SECURITY     → bound to #security
 *   SLACK_WEBHOOK_URL          → fallback (used when channel-specific not set)
 *
 * Production would replace this with a Slack App + `chat.postMessage` for
 * dynamic channel routing per message + interactive Block Kit buttons
 * (Approve / Snooze / threaded replies).
 */

import { Decision, PRContext } from "../types/index.js";

export interface SlackEmitterResult {
  posted: boolean;
  channel?: string;
  error?: string;
}

/** Resolve channel name → bound webhook URL via env. */
function pickWebhook(channel: string | undefined): string | undefined {
  if (channel === "#payments-review" && process.env.SLACK_WEBHOOK_PAYMENTS) return process.env.SLACK_WEBHOOK_PAYMENTS;
  if (channel === "#security"        && process.env.SLACK_WEBHOOK_SECURITY) return process.env.SLACK_WEBHOOK_SECURITY;
  // Fallback chain: generic URL → either specific webhook (whichever's set)
  return process.env.SLACK_WEBHOOK_URL
      ?? process.env.SLACK_WEBHOOK_PAYMENTS
      ?? process.env.SLACK_WEBHOOK_SECURITY;
}

export async function postSlackEscalation(
  ctx: PRContext,
  decision: Decision,
): Promise<SlackEmitterResult> {
  if (!decision.escalate_slack) {
    return { posted: false };
  }
  const webhook = pickWebhook(decision.slack_channel);
  if (!webhook) {
    return {
      posted: false,
      error: "No Slack webhook env set — skipping. Set SLACK_WEBHOOK_PAYMENTS / SLACK_WEBHOOK_SECURITY for channel-routed escalation, or SLACK_WEBHOOK_URL as a single-channel fallback.",
    };
  }

  const prUrl = `https://github.com/${ctx.owner}/${ctx.repo}/pull/${ctx.prNumber}`;
  const tierEmoji = decision.tier === "T4" ? ":no_entry:" : ":warning:";

  const payload = {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${tierEmoji}  ${decision.tier} review needed · PR #${ctx.prNumber}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*<${prUrl}|${ctx.title}>*\n_${ctx.repo} · @${ctx.author}_`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            decision.tier === "T4"
              ? "*Hard block · must restructure.* This change touches a path/pattern that cannot be merged in its current form."
              : "*Senior + domain-owner sign-off required.* AI reviewer never auto-approves T3.",
        },
      },
      ...(decision.top_risks.length > 0
        ? [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "*Top concerns*\n" + decision.top_risks.map((r, i) => `${i + 1}. ${r}`).join("\n"),
              },
            },
          ]
        : []),
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `Routed to *${decision.slack_channel ?? "#eng-reviews"}* · view full review at <${prUrl}|the PR>` },
        ],
      },
      { type: "divider" },
    ],
  };

  try {
    const resp = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      return { posted: false, error: `Slack webhook ${resp.status}: ${await resp.text()}` };
    }
    return { posted: true, channel: decision.slack_channel };
  } catch (err) {
    return { posted: false, error: `Slack POST error: ${(err as Error).message}` };
  }
}
