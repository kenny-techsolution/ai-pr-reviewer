/**
 * Slack incoming-webhook emitter for T3 / T4 escalation.
 *
 * No interactive Block Kit buttons — keeping the demo lean. Production
 * version would use a Slack App with `chat.postMessage` for richer
 * interactivity (Approve / Snooze buttons, threaded replies).
 */

import { Decision, PRContext } from "../types/index.js";

export interface SlackEmitterResult {
  posted: boolean;
  channel?: string;
  error?: string;
}

export async function postSlackEscalation(
  ctx: PRContext,
  decision: Decision,
): Promise<SlackEmitterResult> {
  if (!decision.escalate_slack) {
    return { posted: false };
  }
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) {
    return { posted: false, error: "SLACK_WEBHOOK_URL not set — skipping Slack escalation" };
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
