/**
 * GitHub Reviews API emitter — posts a review (APPROVE / COMMENT / REQUEST_CHANGES)
 * with a markdown body and line-level comments.
 *
 * Uses @octokit/rest. Requires GITHUB_TOKEN with `pull-requests: write` permission
 * (the GITHUB_TOKEN injected into Actions has it by default for the same-repo case).
 *
 * GitHub policy note: the default `GITHUB_TOKEN` injected into Actions cannot
 * use `event: "APPROVE"` — it returns HTTP 422 "GitHub Actions is not permitted
 * to approve pull requests." Production deployments use a GitHub App-issued
 * installation token to bypass this. For demos / personal tokens we gracefully
 * downgrade APPROVE → COMMENT with a clear note explaining the fallback.
 */

import { Octokit } from "@octokit/rest";
import { Decision, PRContext } from "../types/index.js";

export interface GithubEmitterResult {
  posted: boolean;
  review_id?: number;
  /** Set when APPROVE got downgraded to COMMENT due to GitHub Actions policy. */
  fallback?: "approve-to-comment";
  error?: string;
}

const APPROVE_FALLBACK_NOTE =
  "> ⚠️ **AI auto-approve was intended** (clean tier). Posting as COMMENT because GitHub Actions is not permitted to approve PRs by GitHub policy. " +
  "Production would use a GitHub App-issued installation token to actually approve. " +
  "Branch protection determines whether this PR can merge regardless.\n\n---\n\n";

export async function postGithubReview(
  ctx: PRContext,
  decision: Decision,
): Promise<GithubEmitterResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { posted: false, error: "GITHUB_TOKEN not set — skipping GitHub review post" };
  }

  const octokit = new Octokit({ auth: token });

  const event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" = decision.action;

  // Filter line comments to those that have valid path+line, and de-dup per (path,line)
  const seen = new Set<string>();
  const comments = decision.comments
    .filter((c) => c.path && c.line && c.line > 0)
    .filter((c) => {
      const k = `${c.path}:${c.line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 20);

  const reviewComments = comments.map((c) => ({
    path: c.path,
    line: c.line,
    side: "RIGHT" as const,
    body: c.body,
  }));

  try {
    const resp = await octokit.pulls.createReview({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.prNumber,
      commit_id: ctx.headSha,
      body: decision.body,
      event,
      comments: reviewComments,
    });
    return { posted: true, review_id: resp.data.id };
  } catch (err) {
    const msg = (err as Error).message ?? "";

    // Graceful fallback for the GitHub Actions APPROVE policy
    if (event === "APPROVE" && /not permitted to approve/i.test(msg)) {
      try {
        const resp = await octokit.pulls.createReview({
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number: ctx.prNumber,
          commit_id: ctx.headSha,
          body: APPROVE_FALLBACK_NOTE + decision.body,
          event: "COMMENT",
          comments: reviewComments,
        });
        return { posted: true, review_id: resp.data.id, fallback: "approve-to-comment" };
      } catch (err2) {
        return { posted: false, error: `GitHub fallback (approve→comment) failed: ${(err2 as Error).message}` };
      }
    }

    return { posted: false, error: `GitHub API error: ${msg}` };
  }
}
