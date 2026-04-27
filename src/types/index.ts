/**
 * Core types for the AI PR Reviewer pipeline.
 *
 * Data flow:
 *   PR diff → SignalLayer outputs → Aggregator → Tier + RiskReport → Emitters → Event
 */

import { z } from "zod";

// =============================================================================
// TIER MODEL
// =============================================================================
export const TierSchema = z.enum(["T0", "T1", "T2", "T3", "T4"]);
export type Tier = z.infer<typeof TierSchema>;

export const tierOrder: Tier[] = ["T0", "T1", "T2", "T3", "T4"];
export const tierIdx = (t: Tier): number => tierOrder.indexOf(t);

export const tierMeaning: Record<Tier, string> = {
  T0: "Docs · comments · tests · formatter",
  T1: "Low-risk UI · non-payment frontend",
  T2: "Business logic · non-PCI backend",
  T3: "PCI-scoped · payments · auth · KYC · crypto",
  T4: "Hard block · prod-DB schema on payments · IAM widening · CI/CD bypass",
};

export const tierAction: Record<Tier, "APPROVE" | "COMMENT" | "REQUEST_CHANGES"> = {
  T0: "APPROVE",
  T1: "APPROVE",
  T2: "COMMENT",
  T3: "REQUEST_CHANGES",
  T4: "REQUEST_CHANGES",
};

// =============================================================================
// PR CONTEXT — input to the reviewer
// =============================================================================
export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  patch: string; // unified diff for this file
  status: "added" | "modified" | "removed" | "renamed";
}

export interface PRContext {
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  body: string;
  baseRef: string; // base branch
  headRef: string; // PR branch
  headSha: string;
  author: string;
  files: ChangedFile[];
}

// =============================================================================
// SIGNAL LAYERS
// =============================================================================
export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

/** Risk levels are ordered: none < low < medium < high < critical. */
const riskRank: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
export const maxRisk = (a: RiskLevel, b: RiskLevel): RiskLevel =>
  riskRank[a] >= riskRank[b] ? a : b;

export interface LayerSignal {
  /** Highest risk encountered for this layer across the PR. */
  risk: RiskLevel;
  /** Per-file findings: which paths matched what. */
  findings: SignalFinding[];
  /** Free-form notes the layer wants to surface. */
  notes?: string[];
}

export interface SignalFinding {
  path: string;
  rule: string;
  risk: RiskLevel;
  detail?: string;
  /** When relevant, the line range in the diff that triggered the finding. */
  line?: number;
}

// =============================================================================
// AGENT OUTPUTS — strict JSON schema, validated with zod
// =============================================================================
export const AgentFindingSchema = z.object({
  path: z.string(),
  line: z.number().optional(),
  severity: z.enum(["info", "warn", "block"]),
  category: z.string(), // e.g. "secret-exposure" | "rounding" | "missing-validation"
  message: z.string(),
});
export type AgentFinding = z.infer<typeof AgentFindingSchema>;

export const SecurityAgentOutputSchema = z.object({
  agent: z.literal("security"),
  summary: z.string().describe("One-sentence risk summary"),
  findings: z.array(AgentFindingSchema),
  pci_relevance: z.enum(["none", "adjacent", "in-scope"]),
  blocks_merge: z.boolean(),
});
export type SecurityAgentOutput = z.infer<typeof SecurityAgentOutputSchema>;

export const PciAgentOutputSchema = z.object({
  agent: z.literal("pci"),
  summary: z.string(),
  findings: z.array(AgentFindingSchema),
  scope_assessment: z.enum(["pci-in-scope", "pci-adjacent", "out-of-scope"]),
  recommended_tier: TierSchema,
  blocks_merge: z.boolean(),
});
export type PciAgentOutput = z.infer<typeof PciAgentOutputSchema>;

export const ArchAgentOutputSchema = z.object({
  agent: z.literal("arch"),
  summary: z.string(),
  findings: z.array(AgentFindingSchema),
  blast_radius: z.enum(["contained", "module", "service", "platform"]),
  blocks_merge: z.boolean(),
});
export type ArchAgentOutput = z.infer<typeof ArchAgentOutputSchema>;

export type AgentOutput = SecurityAgentOutput | PciAgentOutput | ArchAgentOutput;

// =============================================================================
// AGGREGATOR DECISION
// =============================================================================
export interface Decision {
  tier: Tier;
  /** Final action to post: APPROVE / COMMENT / REQUEST_CHANGES. */
  action: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
  /** Markdown body for the GitHub review. */
  body: string;
  /** Line-level review comments to post alongside the body. */
  comments: { path: string; line: number; body: string }[];
  /** Whether to escalate to Slack (T3 + T4). */
  escalate_slack: boolean;
  /** Slack channel route ("#payments-review" or "#security"). */
  slack_channel?: string;
  /** Top 3 risks to highlight in Slack message. */
  top_risks: string[];
  /** Reasoning trail — for audit and debugging. */
  reasoning: {
    layer_signals: Record<string, LayerSignal>;
    agent_outputs: AgentOutput[];
    rule_matches: string[];
  };
}

// =============================================================================
// EVENTS — what gets written to artifacts/events.jsonl
// =============================================================================
export interface ReviewerEvent {
  pr_id: number;
  repo: string;
  author: string;
  opened_at: string; // ISO
  ai_reviewed_at: string; // ISO
  files_changed: string[];
  ai_tier: Tier;
  ai_decision: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
  layer_signals: Record<string, RiskLevel>;
  tokens_by_agent: Record<string, number>;
  total_tokens: number;
  model_mix: Record<string, string>;
  cost_usd: number;
  latency_ms: number;
  baseline_review_time_min?: number; // estimated, used by the dashboard
  escalated_to_slack: boolean;
  slack_channel?: string;
  error_flag: boolean;
  retry_count: number;
}
