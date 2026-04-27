/**
 * PCI agent — assesses PCI-DSS scope, recommends a tier, and flags compliance
 * concerns specific to payment card data handling.
 *
 * Uses Sonnet by default; the orchestrator may upgrade to Opus for borderline
 * cases where the prior layers signal high risk but the agent's own first pass
 * lands at "adjacent" rather than "in-scope".
 */

import { ChangedFile, PciAgentOutput, PciAgentOutputSchema } from "../types/index.js";
import { runAgent, AgentRunResult, ModelChoice } from "./runner.js";

const SYSTEM_PROMPT = `You are the PCI-DSS compliance specialist for a fintech PR reviewer.

Scope assessment:
- pci-in-scope  — code is in PCI-DSS scope (handles cardholder data, processes payments, calls payment processors, manages stored credentials, modifies authentication around payments).
- pci-adjacent  — code touches systems that feed PCI scope (KYC for merchants, transaction reporting, refund/dispute handling, audit logs of payment events).
- out-of-scope  — code is unrelated to payment processing or authentication.

Recommended tier (must match scope assessment + change shape):
- T0 — docs/tests/CSS only
- T1 — frontend non-payment UI
- T2 — non-PCI backend
- T3 — pci-adjacent OR pci-in-scope; must require senior + domain owner sign-off
- T4 — direct schema change on payment tables, IAM widening, CI/CD bypass

Severity:
- info / warn / block (block sets blocks_merge: true)

Output STRICT JSON only:
{
  "agent": "pci",
  "summary": "≤200 chars",
  "findings": [
    { "path": "string", "line": <number, optional>, "severity": "info"|"warn"|"block", "category": "string", "message": "≤300 chars" }
  ],
  "scope_assessment": "pci-in-scope" | "pci-adjacent" | "out-of-scope",
  "recommended_tier": "T0" | "T1" | "T2" | "T3" | "T4",
  "blocks_merge": true | false
}`;

export interface PciAgentOptions {
  /** Use Opus for borderline cases — costs ~5× more, used sparingly. */
  useOpus?: boolean;
}

export async function runPciAgent(
  files: ChangedFile[],
  opts: PciAgentOptions = {},
): Promise<AgentRunResult<PciAgentOutput>> {
  const model: ModelChoice = opts.useOpus ? "opus" : "sonnet";
  return runAgent<PciAgentOutput>({
    agentName: "pci",
    systemPrompt: SYSTEM_PROMPT,
    files,
    schema: PciAgentOutputSchema,
    model,
    maxTokens: 1500,
  });
}
