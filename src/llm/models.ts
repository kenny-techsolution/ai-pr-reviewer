/**
 * Model registry — maps logical roles ("classifier", "agent", "agent-opus")
 * to provider-specific model IDs and pricing.
 *
 * Env overrides:
 *   MODEL_CLASSIFIER    — overrides the classifier model ID for the active provider
 *   MODEL_AGENT         — overrides the agent model ID
 *   MODEL_AGENT_OPUS    — overrides the high-capability agent model ID
 *
 * When an override is set, we keep the role's default pricing as an estimate
 * (cost reporting will be approximate). Production should maintain a fuller
 * registry per model ID.
 */

export type ModelRole = "classifier" | "agent" | "agent-opus";
export type Provider = "anthropic" | "openrouter";

export interface ModelEntry {
  id: string;
  /** Price per 1M input tokens, USD. */
  in_per_m: number;
  /** Price per 1M output tokens, USD. */
  out_per_m: number;
}

/**
 * Pricing reflects rates current as of 2026-Q1. Update quarterly per provider
 * publication; OpenRouter inherits underlying provider rates with a small markup.
 */
const REGISTRY: Record<Provider, Record<ModelRole, ModelEntry>> = {
  anthropic: {
    classifier:   { id: "claude-haiku-4-5",  in_per_m: 1.0,  out_per_m: 5.0 },
    agent:        { id: "claude-sonnet-4-6", in_per_m: 3.0,  out_per_m: 15.0 },
    "agent-opus": { id: "claude-opus-4-7",   in_per_m: 15.0, out_per_m: 75.0 },
  },
  openrouter: {
    classifier:   { id: "anthropic/claude-haiku-4-5",  in_per_m: 1.0,  out_per_m: 5.0 },
    agent:        { id: "anthropic/claude-sonnet-4-6", in_per_m: 3.0,  out_per_m: 15.0 },
    "agent-opus": { id: "anthropic/claude-opus-4-7",   in_per_m: 15.0, out_per_m: 75.0 },
  },
};

/**
 * Resolve the model entry for a (provider, role) pair, applying env overrides.
 * If an override is set the ID changes but we keep the role's default pricing
 * as a rough estimate.
 */
export function resolveModel(provider: Provider, role: ModelRole): ModelEntry {
  const envKey = `MODEL_${role.toUpperCase().replace(/-/g, "_")}`;
  const override = process.env[envKey];
  const baseEntry = REGISTRY[provider][role];
  if (override && override.length > 0) {
    return { id: override, in_per_m: baseEntry.in_per_m, out_per_m: baseEntry.out_per_m };
  }
  return baseEntry;
}

export function priceCall(model: ModelEntry, tokensIn: number, tokensOut: number): number {
  return (tokensIn / 1_000_000) * model.in_per_m + (tokensOut / 1_000_000) * model.out_per_m;
}
