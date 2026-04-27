/**
 * Layer 1: path-based risk classification.
 *
 * Cheapest layer. Pure glob matching against an explicit ordered rule set —
 * no language model involvement, deterministic, sub-millisecond.
 *
 * The rules below mirror pos-lite's CODEOWNERS structure but are kept
 * separate so they can evolve at the reviewer's pace (e.g., when a new
 * PCI-adjacent path is discovered via audit retrace).
 */

import { minimatch } from "minimatch";
import {
  ChangedFile,
  LayerSignal,
  RiskLevel,
  SignalFinding,
  Tier,
  maxRisk,
} from "../types/index.js";

interface PathRule {
  glob: string;
  tier: Tier;
  rationale: string;
}

/** Ordered list — first match wins for tier assignment, but we record all matches. */
const PATH_RULES: PathRule[] = [
  // ---------- T4 (hard block territory) ----------
  { glob: "migrations/**/*payments*",      tier: "T4", rationale: "schema change on payments table — must restructure" },
  { glob: "migrations/**/*billing*",        tier: "T4", rationale: "schema change on billing table — must restructure" },
  { glob: ".github/workflows/**",           tier: "T4", rationale: "CI/CD workflow change — supply chain surface" },
  { glob: "infra/iam/**",                   tier: "T4", rationale: "IAM policy change — privilege escalation surface" },

  // ---------- T3 (PCI / payments / auth / KYC / crypto) ----------
  { glob: "**/payments/**",                 tier: "T3", rationale: "PCI-scoped: payment processing" },
  { glob: "**/billing/**",                  tier: "T3", rationale: "PCI-scoped: billing logic" },
  { glob: "**/auth/**",                     tier: "T3", rationale: "Auth surface: token issuance, session, RBAC" },
  { glob: "**/kyc/**",                      tier: "T3", rationale: "PCI-adjacent: KYC compliance data" },
  { glob: "**/crypto/**",                   tier: "T3", rationale: "Cryptographic key management" },
  { glob: "**/secrets/**",                  tier: "T3", rationale: "Secrets handling" },

  // ---------- T2 (business logic · non-PCI backend) ----------
  { glob: "api/**",                         tier: "T2", rationale: "Backend business logic" },
  { glob: "services/**",                    tier: "T2", rationale: "Backend service" },

  // ---------- T1 (low-risk frontend) ----------
  { glob: "web/src/components/**",          tier: "T1", rationale: "UI component" },
  { glob: "web/src/pages/**",               tier: "T1", rationale: "UI page" },
  { glob: "web/src/hooks/**",               tier: "T1", rationale: "Frontend hook" },
  { glob: "web/**",                         tier: "T1", rationale: "Frontend code" },

  // ---------- T0 (docs · tests · styles) ----------
  { glob: "docs/**",                        tier: "T0", rationale: "Documentation" },
  { glob: "**/*_test.go",                   tier: "T0", rationale: "Go test file" },
  { glob: "**/*.test.ts",                   tier: "T0", rationale: "TS test file" },
  { glob: "**/*.test.tsx",                  tier: "T0", rationale: "TS test file" },
  { glob: "**/*.css",                       tier: "T0", rationale: "Stylesheet" },
  { glob: "**/*.md",                        tier: "T0", rationale: "Markdown" },
];

const TIER_TO_RISK: Record<Tier, RiskLevel> = {
  T0: "none",
  T1: "low",
  T2: "medium",
  T3: "high",
  T4: "critical",
};

export interface PathLayerResult extends LayerSignal {
  /** Highest-tier rule triggered across the PR (or null if no rule matched). */
  highest_tier: Tier | null;
}

export function runPathLayer(files: ChangedFile[]): PathLayerResult {
  const findings: SignalFinding[] = [];
  let highestRisk: RiskLevel = "none";
  let highestTier: Tier | null = null;

  for (const file of files) {
    const matched = matchFirst(file.path);
    if (!matched) continue;

    const risk = TIER_TO_RISK[matched.tier];
    findings.push({
      path: file.path,
      rule: `path:${matched.glob}`,
      risk,
      detail: matched.rationale,
    });

    highestRisk = maxRisk(highestRisk, risk);
    if (highestTier === null || tierGt(matched.tier, highestTier)) {
      highestTier = matched.tier;
    }
  }

  return {
    risk: highestRisk,
    findings,
    notes: highestTier
      ? [`Path-based highest tier: ${highestTier}`]
      : ["No path rule matched any changed file"],
    highest_tier: highestTier,
  };
}

function matchFirst(path: string): PathRule | null {
  for (const rule of PATH_RULES) {
    if (minimatch(path, rule.glob, { dot: true })) return rule;
  }
  return null;
}

function tierGt(a: Tier, b: Tier): boolean {
  const order = ["T0", "T1", "T2", "T3", "T4"];
  return order.indexOf(a) > order.indexOf(b);
}
