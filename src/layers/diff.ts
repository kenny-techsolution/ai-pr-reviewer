/**
 * Layer 2: diff heuristics — patterns inside the unified diff that signal risk
 * regardless of what file was touched.
 *
 * Examples:
 *   - migration adds a NOT NULL column without DEFAULT
 *   - .env or secrets file changes
 *   - dependency bump for a security-sensitive library
 *   - any DROP / TRUNCATE in SQL
 *   - protected_branch / branch protection edits
 */

import {
  ChangedFile,
  LayerSignal,
  RiskLevel,
  SignalFinding,
  maxRisk,
} from "../types/index.js";

interface DiffRule {
  id: string;
  pattern: RegExp;
  risk: RiskLevel;
  rationale: string;
  /** Optional file-path constraint — only check the diff if the path matches. */
  pathHint?: RegExp;
}

const DIFF_RULES: DiffRule[] = [
  // ---------- critical ----------
  { id: "sql-drop",          pattern: /^\+\s*(DROP\s+(TABLE|INDEX|SCHEMA|DATABASE)|TRUNCATE)\b/im,
    risk: "critical", rationale: "Destructive SQL: DROP / TRUNCATE — irreversible without restore",
    pathHint: /\.(sql|migrations?\/)/i },
  { id: "sql-not-null-no-default", pattern: /^\+\s*ALTER\s+TABLE.*ADD\s+COLUMN.*NOT\s+NULL(?!.*DEFAULT)/im,
    risk: "critical", rationale: "Adding NOT NULL column without DEFAULT — production migration will fail" },
  { id: "branch-protection-disabled", pattern: /required_status_checks.*null|enforce_admins.*false/i,
    risk: "critical", rationale: "Branch protection rule weakened or disabled" },
  { id: "secret-committed", pattern: /^\+.*(api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9]{20,}["']/im,
    risk: "critical", rationale: "Possible secret committed in plaintext" },
  { id: "iam-policy-wildcard", pattern: /^\+.*"Action"\s*:\s*"\*"|"Resource"\s*:\s*"\*"/im,
    risk: "critical", rationale: "IAM policy with wildcard Action or Resource" },

  // ---------- high ----------
  { id: "env-file-change", pattern: /./,
    risk: "high", rationale: ".env file modified — verify no secret committed",
    pathHint: /(^|\/)\.env(\.|$)/ },
  { id: "schema-change-payments", pattern: /^\+\s*ALTER\s+TABLE\s+(payments|charges|refunds|transactions)/im,
    risk: "high", rationale: "Schema change on payment-relevant table" },
  { id: "dependency-bump-security", pattern: /^\+.*"(jsonwebtoken|crypto-js|bcrypt|argon2|node-forge|openssl)"\s*:/im,
    risk: "high", rationale: "Security-sensitive dependency version bump" },
  { id: "ci-workflow-change", pattern: /./,
    risk: "high", rationale: "GitHub Actions workflow changed — supply-chain surface",
    pathHint: /^\.github\/workflows\// },

  // ---------- medium ----------
  { id: "dependency-bump", pattern: /^\+.*"\^?\d+\.\d+/m,
    risk: "medium", rationale: "Dependency bump in package.json",
    pathHint: /package\.json$/ },
  { id: "go-mod-change", pattern: /^\+\s*[a-z0-9./-]+\s+v\d+\.\d+/im,
    risk: "medium", rationale: "go.mod dependency change",
    pathHint: /go\.mod$/ },
  { id: "large-diff", pattern: /./, // we handle by line count below; placeholder rule
    risk: "medium", rationale: "Large diff (>200 lines) — split-up recommended" },

  // ---------- low ----------
  { id: "env-getenv-added", pattern: /^\+.*(os\.Getenv|process\.env\.)/im,
    risk: "low", rationale: "Reads environment — check for secret usage" },
];

export interface DiffLayerResult extends LayerSignal {}

export function runDiffLayer(files: ChangedFile[]): DiffLayerResult {
  const findings: SignalFinding[] = [];
  let highest: RiskLevel = "none";

  // Aggregate diff size signal first
  const totalChanged = files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  if (totalChanged > 200) {
    findings.push({
      path: "*",
      rule: "diff:large-diff",
      risk: "medium",
      detail: `${totalChanged} lines changed — consider splitting into smaller PRs`,
    });
    highest = maxRisk(highest, "medium");
  }

  for (const file of files) {
    for (const rule of DIFF_RULES) {
      if (rule.id === "large-diff") continue; // already handled

      // Path constraint check
      if (rule.pathHint && !rule.pathHint.test(file.path)) continue;

      // Path-only rules (e.g., env file change) where pattern is /./
      if (rule.pattern.source === "." && rule.pathHint) {
        findings.push({
          path: file.path,
          rule: `diff:${rule.id}`,
          risk: rule.risk,
          detail: rule.rationale,
        });
        highest = maxRisk(highest, rule.risk);
        continue;
      }

      // Regex against patch text
      const lines = file.patch.split("\n");
      lines.forEach((line, idx) => {
        if (rule.pattern.test(line)) {
          findings.push({
            path: file.path,
            rule: `diff:${rule.id}`,
            risk: rule.risk,
            detail: rule.rationale,
            line: estimateNewLine(file.patch, idx),
          });
          highest = maxRisk(highest, rule.risk);
        }
      });
    }
  }

  return {
    risk: highest,
    findings,
    notes: [`${findings.length} diff-heuristic finding(s)`],
  };
}

/**
 * Estimate the line number in the new file from a position in the unified diff.
 * Returns the new-file line number if the index falls within a hunk; otherwise 0.
 */
function estimateNewLine(patch: string, hunkLineIdx: number): number {
  const lines = patch.split("\n");
  let newLine = 0;
  for (let i = 0; i <= hunkLineIdx && i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const hunk = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)/.exec(line);
    if (hunk && hunk[1]) {
      newLine = parseInt(hunk[1], 10) - 1;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) newLine++;
    else if (!line.startsWith("-") && !line.startsWith("---")) newLine++;
  }
  return newLine;
}
