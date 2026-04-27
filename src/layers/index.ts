/**
 * Layer orchestrator — runs the 4 risk-signal layers in their cheap-first order.
 *
 * Layer 5 (LLM classifier) only fires when the deterministic layers disagree
 * meaningfully — keeps cost bounded.
 */

import {
  ChangedFile,
  LayerSignal,
  RiskLevel,
  Tier,
  maxRisk,
} from "../types/index.js";
import { runPathLayer, PathLayerResult } from "./path.js";
import { runDiffLayer, DiffLayerResult } from "./diff.js";
import { runSemanticLayer, SemanticLayerResult } from "./semantic.js";
import { runLlmLayer, LlmLayerResult } from "./llm.js";

export interface LayerStackResult {
  path: PathLayerResult;
  diff: DiffLayerResult;
  semantic: SemanticLayerResult;
  llm: LlmLayerResult | null;
  /** Highest risk across all layers — input to the aggregator. */
  combined_risk: RiskLevel;
  /** Whether layer 5 (LLM) ran. */
  llm_fired: boolean;
}

export async function runLayerStack(files: ChangedFile[]): Promise<LayerStackResult> {
  // Layer 1 — path
  const path = runPathLayer(files);

  // Layer 2 — diff heuristics
  const diff = runDiffLayer(files);

  // Layer 3 — semantic / AST-like
  const semantic = runSemanticLayer(files);

  // Should layer 5 (LLM) fire? Yes if:
  //   - path layer didn't match any rule (ambiguous), OR
  //   - semantic risk exceeds path-implied risk by 2+ levels (escalation candidate), OR
  //   - diff layer found critical-level signals that path didn't catch
  const llmShouldFire =
    path.highest_tier === null ||
    riskGap(semantic.risk, path.risk) >= 2 ||
    riskRank(diff.risk) >= riskRank("critical");

  let llm: LlmLayerResult | null = null;
  if (llmShouldFire) {
    llm = await runLlmLayer({
      files,
      prior_hints: [
        { layer: "path",     risk: path.risk,     notes: path.notes },
        { layer: "diff",     risk: diff.risk,     notes: diff.notes },
        { layer: "semantic", risk: semantic.risk, notes: semantic.notes },
      ],
    });
  }

  const combined = [path, diff, semantic, llm]
    .filter(Boolean)
    .reduce<RiskLevel>((acc, l) => maxRisk(acc, (l as LayerSignal).risk), "none");

  return {
    path,
    diff,
    semantic,
    llm,
    combined_risk: combined,
    llm_fired: llm !== null,
  };
}

const riskValues: Record<RiskLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};
const riskRank = (r: RiskLevel): number => riskValues[r];
const riskGap = (a: RiskLevel, b: RiskLevel): number => riskRank(a) - riskRank(b);
