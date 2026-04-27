/**
 * Ground-truth labeling pass for backtest events — core-API edition.
 *
 * The previous version used GitHub's Search API which has a 30 req/min
 * secondary rate limit. This version uses the core PRs API (5000 req/hr)
 * by listing recent merged PRs once, filtering by hotfix-pattern title,
 * fetching files for each candidate, then scanning the cache against
 * each backtest event's T3/T4 classification.
 *
 * Usage:
 *   GITHUB_TOKEN=$(gh auth token) \
 *   npx tsx scripts/ground-truth.ts \
 *     --in artifacts/backtest-events.jsonl \
 *     --out artifacts/backtest-events.gt.jsonl \
 *     --window-days 14
 */

import { Octokit } from "@octokit/rest";
import * as fs from "fs";

interface BacktestEvent {
  pr_id: number;
  repo: string;
  ai_tier: "T0" | "T1" | "T2" | "T3" | "T4";
  files_changed: string[];
  ai_reviewed_at: string;
  [k: string]: unknown;
}

interface GroundTruth {
  caused_hotfix: boolean;
  evidence_pr?: number;
  evidence_url?: string;
  evidence_lag_days?: number;
  evidence_title?: string;
  // explicit "we didn't determine" — distinct from "we checked, no hotfix"
  inconclusive?: boolean;
}

const FIX_TITLE_RE = /\b(fix|revert|hotfix|patch|rollback|emergency)\b/i;

function parseArgs() {
  const out = { in: "", out: "", windowDays: 14, lookbackDays: 120 };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--in") out.in = process.argv[++i] ?? "";
    else if (a === "--out") out.out = process.argv[++i] ?? "";
    else if (a === "--window-days") out.windowDays = parseInt(process.argv[++i] ?? "14", 10);
    else if (a === "--lookback-days") out.lookbackDays = parseInt(process.argv[++i] ?? "120", 10);
  }
  if (!out.in) throw new Error("--in is required");
  if (!out.out) out.out = out.in.replace(/\.jsonl$/, ".gt.jsonl");
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface HotfixCandidate {
  number: number;
  title: string;
  merged_at: string;
  html_url: string;
  files: string[];
}

/** Fetch all merged PRs across the last N days, filtered to hotfix-titled ones. */
async function loadHotfixCandidates(
  octokit: Octokit,
  owner: string,
  repo: string,
  lookbackDays: number,
): Promise<HotfixCandidate[]> {
  const cutoff = Date.now() - lookbackDays * 86400 * 1000;
  const candidates: HotfixCandidate[] = [];

  // Page through closed PRs until we go past the cutoff. ~150 per page max.
  console.log(`▶ paging closed PRs from ${owner}/${repo} (lookback ${lookbackDays}d)…`);
  let page = 1;
  let scanned = 0;
  outer: while (page < 25) {
    const resp = await octokit.pulls.list({
      owner,
      repo,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: 100,
      page,
    });
    if (resp.data.length === 0) break;
    for (const pr of resp.data) {
      scanned += 1;
      if (!pr.merged_at) continue;
      if (new Date(pr.merged_at).getTime() < cutoff) {
        // Past our window — stop paging.
        break outer;
      }
      if (FIX_TITLE_RE.test(pr.title)) {
        candidates.push({
          number: pr.number,
          title: pr.title,
          merged_at: pr.merged_at,
          html_url: pr.html_url,
          files: [], // filled in next step
        });
      }
    }
    page += 1;
    await sleep(150); // gentle pacing on core API
  }
  console.log(`  scanned ${scanned} PRs · ${candidates.length} match hotfix pattern`);

  // Fetch files for each candidate (one core-API call per PR).
  console.log(`▶ fetching files for ${candidates.length} hotfix candidates…`);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    process.stdout.write(`  [${i + 1}/${candidates.length}] PR#${c.number} · ${c.title.slice(0, 50)}…\r`);
    try {
      const filesResp = await octokit.pulls.listFiles({
        owner,
        repo,
        pull_number: c.number,
        per_page: 100,
      });
      c.files = filesResp.data.map((f) => f.filename);
    } catch (err) {
      console.log(`\n  ✗ PR#${c.number}: ${(err as Error).message}`);
    }
    await sleep(150);
  }
  console.log("");
  return candidates;
}

async function main() {
  const args = parseArgs();
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("✗ GITHUB_TOKEN not set");
    process.exit(1);
  }
  const octokit = new Octokit({ auth: token });

  const lines = fs.readFileSync(args.in, "utf-8").split("\n").filter((l) => l.trim());
  const events: BacktestEvent[] = lines.map((l) => JSON.parse(l));
  console.log(`▶ ${events.length} events loaded from ${args.in}`);

  // Build the hotfix candidate set once for the whole repo.
  // (All events should have the same .repo; if not, we'd batch by repo.)
  const repos = new Set(events.map((e) => e.repo));
  const candidatesByRepo = new Map<string, HotfixCandidate[]>();
  for (const repoFull of repos) {
    const [owner, repo] = repoFull.split("/");
    candidatesByRepo.set(repoFull, await loadHotfixCandidates(octokit, owner, repo, args.lookbackDays));
  }

  // Match each T3/T4 event against the candidate cache.
  const enriched: (BacktestEvent & { ground_truth: GroundTruth })[] = [];
  let hits = 0;
  let candidateCount = 0;
  for (const e of events) {
    const isCandidate = e.ai_tier === "T3" || e.ai_tier === "T4";
    if (!isCandidate) {
      enriched.push({ ...e, ground_truth: { caused_hotfix: false } });
      continue;
    }
    candidateCount += 1;
    const reviewedAt = new Date(e.ai_reviewed_at).getTime();
    const cutoff = reviewedAt + args.windowDays * 86400 * 1000;
    const fileSet = new Set(e.files_changed);
    const pool = candidatesByRepo.get(e.repo) ?? [];

    let evidence: HotfixCandidate | null = null;
    for (const c of pool) {
      if (c.number === e.pr_id) continue;
      const ts = new Date(c.merged_at).getTime();
      if (ts <= reviewedAt) continue;
      if (ts > cutoff) continue;
      if (!c.files.some((f) => fileSet.has(f))) continue;
      evidence = c;
      break;
    }

    if (evidence) {
      hits += 1;
      const lagMs = new Date(evidence.merged_at).getTime() - reviewedAt;
      enriched.push({
        ...e,
        ground_truth: {
          caused_hotfix: true,
          evidence_pr: evidence.number,
          evidence_url: evidence.html_url,
          evidence_lag_days: Math.round(lagMs / 86400000),
          evidence_title: evidence.title.slice(0, 120),
        },
      });
      console.log(`  PR#${e.pr_id} (${e.ai_tier}) → HOTFIX in PR#${evidence.number} (+${Math.round(lagMs / 86400000)}d)`);
    } else {
      enriched.push({ ...e, ground_truth: { caused_hotfix: false } });
      console.log(`  PR#${e.pr_id} (${e.ai_tier}) → clean (no hotfix overlap in window)`);
    }
  }

  fs.writeFileSync(args.out, enriched.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const precision = candidateCount > 0 ? hits / candidateCount : 0;
  console.log("");
  console.log("════════════════════════════════════════════════════");
  console.log("  Ground-truth pass complete");
  console.log("════════════════════════════════════════════════════");
  console.log(`  Total events:       ${events.length}`);
  console.log(`  T3/T4 candidates:   ${candidateCount}`);
  console.log(`  Hotfix evidence:    ${hits} (${(precision * 100).toFixed(1)}% precision on T3+)`);
  console.log(`  Output:             ${args.out}`);
  console.log("════════════════════════════════════════════════════");
  console.log("");
  console.log("  ⚠️  'caused_hotfix: false' means: we didn't find a hotfix PR within");
  console.log("      the window touching the same files. Could be a true clean classification,");
  console.log("      or the issue was caught pre-merge / fixed silently. One signal in a portfolio.");
}

main().catch((err) => {
  console.error("✗ fatal:", err);
  process.exit(1);
});
