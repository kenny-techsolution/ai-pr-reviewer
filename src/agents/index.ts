/**
 * Specialist agent orchestrator — runs security/pci/arch in parallel, gates
 * which agents run based on the layer-stack signals to keep cost bounded.
 */

import { AgentOutput, ChangedFile, RiskLevel } from "../types/index.js";
import { LayerStackResult } from "../layers/index.js";
import { runSecurityAgent } from "./security.js";
import { runPciAgent } from "./pci.js";
import { runArchAgent } from "./arch.js";
import { AgentRunResult } from "./runner.js";

export interface AgentSwarmResult {
  outputs: AgentOutput[];
  errors: string[];
  tokens_by_agent: Record<string, number>;
  total_tokens: number;
  cost_usd: number;
  models_used: Record<string, string>;
}

/**
 * Decide which agents to run based on layer signals.
 *
 * Cost rule: only fire agents that earn their slot.
 * - T0/T1 (low risk): no agents — too cheap to bother
 * - T2: arch only (covers business-logic blast radius)
 * - T3+: all three agents in parallel
 */
function selectAgents(layers: LayerStackResult): {
  security: boolean;
  pci: boolean;
  arch: boolean;
  pciOpus: boolean;
} {
  const risk = layers.combined_risk;
  const high = risk === "high" || risk === "critical";
  const medium = risk === "medium" || high;

  // PCI agent uses Opus for the trickiest borderline cases — when path says T2/T3
  // boundary and semantic finds payment-API patterns.
  const pciOpus =
    layers.path.highest_tier === "T3" &&
    layers.semantic.findings.some((f) => f.risk === "critical");

  return {
    security: medium,
    pci: high || layers.path.highest_tier === "T3" || layers.path.highest_tier === "T4",
    arch: medium,
    pciOpus,
  };
}

export async function runAgentSwarm(
  files: ChangedFile[],
  layers: LayerStackResult,
): Promise<AgentSwarmResult> {
  const select = selectAgents(layers);

  const promises: Promise<AgentRunResult<AgentOutput>>[] = [];
  const labels: string[] = [];

  if (select.security) {
    promises.push(runSecurityAgent(files) as Promise<AgentRunResult<AgentOutput>>);
    labels.push("security");
  }
  if (select.pci) {
    promises.push(runPciAgent(files, { useOpus: select.pciOpus }) as Promise<AgentRunResult<AgentOutput>>);
    labels.push("pci");
  }
  if (select.arch) {
    promises.push(runArchAgent(files) as Promise<AgentRunResult<AgentOutput>>);
    labels.push("arch");
  }

  const results = await Promise.all(promises);

  const outputs: AgentOutput[] = [];
  const errors: string[] = [];
  const tokensByAgent: Record<string, number> = {};
  let totalTokens = 0;
  let totalCost = 0;
  const models: Record<string, string> = {};

  results.forEach((r, i) => {
    const label = labels[i] ?? "unknown";
    if (r.output) outputs.push(r.output);
    if (r.error) errors.push(r.error);
    tokensByAgent[label] = r.tokens_in + r.tokens_out;
    totalTokens += r.tokens_in + r.tokens_out;
    totalCost += r.cost_usd;
    models[label] = r.model;
  });

  return {
    outputs,
    errors,
    tokens_by_agent: tokensByAgent,
    total_tokens: totalTokens,
    cost_usd: totalCost,
    models_used: models,
  };
}
