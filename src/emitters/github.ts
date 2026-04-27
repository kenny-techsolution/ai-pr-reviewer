/**
 * GitHub Reviews API emitter — posts a review (APPROVE / COMMENT / REQUEST_CHANGES)
 * with a markdown body and line-level comments.
 *
 * Uses @octokit/rest. Requires GITHUB_TOKEN with `pull-requests: write` permission
 * (the GITHUB_TOKEN injected into Actions has it by default for the same-repo case).
 */

import { Octokit } from "@octokit/rest";
import { Decision, PRContext } from "../types/index.js";

export interface GithubEmitterResult {
  posted: boolean;
  review_id?: number;
  error?: string;
}

export async function postGithubReview(
  ctx: PRContext,
  decision: Decision,
): Promise<GithubEmitterResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { posted: false, error: "GITHUB_TOKEN not set — skipping GitHub review post" };
  }

  const octokit = new Octokit({ auth: token });

  // Map our action to GitHub's review event
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

  try {
    const resp = await octokit.pulls.createReview({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.prNumber,
      commit_id: ctx.headSha,
      body: decision.body,
      event,
      comments: comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: "RIGHT",
        body: c.body,
      })),
    });
    return { posted: true, review_id: resp.data.id };
  } catch (err) {
    return { posted: false, error: `GitHub API error: ${(err as Error).message}` };
  }
}
