/**
 * CLI entry — orchestrates the full reviewer pipeline.
 *
 * Invocation modes:
 *
 *   1) Inside a GitHub Action (default) — reads PR context from GITHUB_*
 *      environment variables and the runner's GITHUB_EVENT_PATH.
 *
 *   2) Local CLI — pass --owner / --repo / --pr explicitly.
 *      Useful for backtest runs and local debugging.
 */

import { readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { aggregate } from "./aggregator.js";
import { runAgentSwarm } from "./agents/index.js";
import { runLayerStack } from "./layers/index.js";
import { postGithubReview } from "./emitters/github.js";
import { postSlackEscalation } from "./emitters/slack.js";
import { writeEvent } from "./emitters/events.js";
import { ChangedFile, PRContext, ReviewerEvent } from "./types/index.js";

interface CliArgs {
  owner?: string;
  repo?: string;
  pr?: number;
  dryRun?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--owner") out.owner = argv[++i];
    else if (arg === "--repo") out.repo = argv[++i];
    else if (arg === "--pr") out.pr = parseInt(argv[++i] ?? "0", 10);
    else if (arg === "--dry-run") out.dryRun = true;
  }
  return out;
}

async function loadPRContext(args: CliArgs): Promise<PRContext> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && !args.pr) {
    // Running inside GitHub Action — read event payload
    const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
      pull_request?: {
        number: number;
        title: string;
        body?: string;
        head: { ref: string; sha: string };
        base: { ref: string };
        user: { login: string };
      };
      repository: { owner: { login: string }; name: string };
    };
    const pr = event.pull_request;
    if (!pr) throw new Error("No pull_request in GitHub Action event payload");
    const owner = event.repository.owner.login;
    const repo = event.repository.name;
    const prNumber = pr.number;
    const files = await fetchPRFiles(owner, repo, prNumber);
    return {
      owner, repo, prNumber,
      title: pr.title,
      body: pr.body ?? "",
      baseRef: pr.base.ref,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      author: pr.user.login,
      files,
    };
  }

  // Local CLI mode
  if (!args.owner || !args.repo || !args.pr) {
    throw new Error("Local mode requires --owner --repo --pr");
  }
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const { data: pr } = await octokit.pulls.get({
    owner: args.owner, repo: args.repo, pull_number: args.pr,
  });
  const files = await fetchPRFiles(args.owner, args.repo, args.pr);
  return {
    owner: args.owner, repo: args.repo, prNumber: args.pr,
    title: pr.title, body: pr.body ?? "",
    baseRef: pr.base.ref, headRef: pr.head.ref, headSha: pr.head.sha,
    author: pr.user?.login ?? "unknown",
    files,
  };
}

async function fetchPRFiles(owner: string, repo: string, prNumber: number): Promise<ChangedFile[]> {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const allFiles: ChangedFile[] = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.pulls.listFiles({
      owner, repo, pull_number: prNumber, per_page: 100, page,
    });
    if (data.length === 0) break;
    for (const f of data) {
      allFiles.push({
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? "",
        status: (f.status as ChangedFile["status"]) ?? "modified",
      });
    }
    if (data.length < 100) break;
    page++;
  }
  return allFiles;
}

async function main() {
  const t0 = Date.now();
  const args = parseArgs(process.argv);

  console.log("[reviewer] loading PR context…");
  const ctx = await loadPRContext(args);
  console.log(`[reviewer] PR ${ctx.owner}/${ctx.repo}#${ctx.prNumber} · ${ctx.files.length} files · "${ctx.title}"`);

  console.log("[reviewer] running layer stack (path · diff · semantic · llm)…");
  const layers = await runLayerStack(ctx.files);
  console.log(`[reviewer] layers · combined risk: ${layers.combined_risk} · path tier: ${layers.path.highest_tier} · LLM fired: ${layers.llm_fired}`);

  console.log("[reviewer] running agent swarm…");
  const swarm = await runAgentSwarm(ctx.files, layers);
  console.log(`[reviewer] swarm · ${swarm.outputs.length} agents · ${swarm.total_tokens} tokens · $${swarm.cost_usd.toFixed(4)}`);
  if (swarm.errors.length > 0) console.warn(`[reviewer] swarm errors: ${swarm.errors.join("; ")}`);

  console.log("[reviewer] aggregating decision…");
  const decision = aggregate({ ctx, layers, agents: swarm.outputs });
  console.log(`[reviewer] decision · tier: ${decision.tier} · action: ${decision.action} · escalate slack: ${decision.escalate_slack}`);

  if (args.dryRun) {
    console.log("[reviewer] DRY RUN — skipping GitHub + Slack posts");
    console.log("\n--- review body ---\n" + decision.body);
  } else {
    console.log("[reviewer] posting GitHub review + Slack escalation in parallel…");
    const [gh, slack] = await Promise.all([
      postGithubReview(ctx, decision),
      postSlackEscalation(ctx, decision),
    ]);
    if (gh.posted) console.log(`[reviewer] GitHub review posted (id ${gh.review_id})`);
    else console.warn(`[reviewer] GitHub: ${gh.error}`);
    if (slack.posted) console.log(`[reviewer] Slack escalation posted to ${slack.channel}`);
    else if (decision.escalate_slack) console.warn(`[reviewer] Slack: ${slack.error}`);
  }

  // Compose event for events.jsonl
  const totalCost = swarm.cost_usd + (layers.llm?.cost_usd ?? 0);
  const totalTokens = swarm.total_tokens + ((layers.llm?.tokens_in ?? 0) + (layers.llm?.tokens_out ?? 0));
  const tokensByAgent = { ...swarm.tokens_by_agent };
  if (layers.llm) tokensByAgent.classifier = (layers.llm.tokens_in + layers.llm.tokens_out);
  const modelMix = { ...swarm.models_used };
  if (layers.llm) modelMix.classifier = layers.llm.model;

  const layerSignals = {
    path:     layers.path.risk,
    diff:     layers.diff.risk,
    semantic: layers.semantic.risk,
    llm:      layers.llm ? layers.llm.risk : "none" as const,
  };

  const event: ReviewerEvent = {
    pr_id: ctx.prNumber,
    repo: `${ctx.owner}/${ctx.repo}`,
    author: ctx.author,
    opened_at: new Date(Date.now() - (Date.now() - t0)).toISOString(), // approx
    ai_reviewed_at: new Date().toISOString(),
    files_changed: ctx.files.map((f) => f.path),
    ai_tier: decision.tier,
    ai_decision: decision.action,
    layer_signals: layerSignals,
    tokens_by_agent: tokensByAgent,
    total_tokens: totalTokens,
    model_mix: modelMix,
    cost_usd: totalCost,
    latency_ms: Date.now() - t0,
    escalated_to_slack: decision.escalate_slack,
    ...(decision.slack_channel ? { slack_channel: decision.slack_channel } : {}),
    error_flag: swarm.errors.length > 0,
    retry_count: 0,
  };
  const evRes = writeEvent(event);
  if (evRes.written) console.log(`[reviewer] event written to ${evRes.path}`);
  else console.warn(`[reviewer] event write failed: ${evRes.error}`);

  console.log(`[reviewer] done · total latency ${event.latency_ms}ms · total cost $${totalCost.toFixed(4)}`);
}

main().catch((err) => {
  console.error("[reviewer] fatal error:", err);
  process.exit(1);
});
