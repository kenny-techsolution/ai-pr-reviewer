/**
 * Layer 5: LLM-based tier classifier.
 *
 * Last-resort layer. Fires only when paths/diff/semantic disagree or are
 * ambiguous (e.g. path says T2 but semantic finds payment-API calls).
 *
 * Provider-agnostic — uses the LlmClient adapter so the same code path runs
 * against Anthropic-direct or OpenRouter (or future providers) based on env
 * configuration. See src/llm/ for client + model registry.
 */

import { z } from "zod";
import {
  ChangedFile,
  LayerSignal,
  RiskLevel,
  Tier,
  TierSchema,
  tierMeaning,
} from "../types/index.js";
import { extractJson, getClient } from "../llm/index.js";

const ClassifierResponseSchema = z.object({
  tier: TierSchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(400),
  primary_signals: z.array(z.string()).max(5),
});
type ClassifierResponse = z.infer<typeof ClassifierResponseSchema>;

export interface LlmLayerResult extends LayerSignal {
  estimated_tier: Tier | null;
  confidence: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  model: string;
  provider: string;
}

const SYSTEM_PROMPT = `You are a risk classifier for a fintech PR reviewer.
Classify the PR into exactly one tier. Use the rules verbatim.

Tier definitions:
${Object.entries(tierMeaning).map(([t, m]) => `- ${t}: ${m}`).join("\n")}

Decision rules (in order):
1. Any change to migrations on payment tables, IAM policies, or CI/CD workflows → T4.
2. Any change to payments/auth/KYC/crypto/billing paths → T3.
3. Backend business-logic changes (api/ outside the T3 paths) → T2.
4. UI components, frontend routes, frontend hooks → T1.
5. Docs-only, tests-only, CSS-only changes → T0.

Output STRICT JSON only. No prose. Schema:
{
  "tier": "T0" | "T1" | "T2" | "T3" | "T4",
  "confidence": 0.0–1.0,
  "rationale": "≤400 chars",
  "primary_signals": ["≤5 short strings naming the rules that fired"]
}`;

export interface LlmLayerInput {
  files: ChangedFile[];
  /** Optional pre-computed signals from earlier layers — gives the LLM context. */
  prior_hints?: { layer: string; risk: RiskLevel; notes?: string[] }[];
}

const tierToRisk: Record<Tier, RiskLevel> = {
  T0: "none", T1: "low", T2: "medium", T3: "high", T4: "critical",
};

export async function runLlmLayer(input: LlmLayerInput): Promise<LlmLayerResult> {
  // Skip if no provider configured (don't crash, return neutral signal)
  let client;
  try {
    client = getClient();
  } catch (err) {
    return emptyResult(`LLM layer skipped — ${(err as Error).message}`);
  }

  const userMsg = buildUserMessage(input);
  let parsed: ClassifierResponse | null = null;

  try {
    const result = await client.complete({
      modelRole: "classifier",
      systemPrompt: SYSTEM_PROMPT,
      userMessage: userMsg,
      maxTokens: 600,
    });
    parsed = ClassifierResponseSchema.parse(JSON.parse(extractJson(result.text)));

    return {
      risk: tierToRisk[parsed.tier],
      findings: parsed.primary_signals.map((s) => ({
        path: "*",
        rule: `llm:${s.slice(0, 64)}`,
        risk: tierToRisk[parsed!.tier],
        detail: s,
      })),
      notes: [`LLM classified as ${parsed.tier} · confidence ${parsed.confidence.toFixed(2)} · ${parsed.rationale}`],
      estimated_tier: parsed.tier,
      confidence: parsed.confidence,
      tokens_in: result.tokens_in,
      tokens_out: result.tokens_out,
      cost_usd: result.cost_usd,
      model: result.model_id,
      provider: result.provider,
    };
  } catch (err) {
    return emptyResult(`LLM layer failure: ${(err as Error).message}`);
  }
}

function emptyResult(note: string): LlmLayerResult {
  return {
    risk: "none",
    findings: [],
    notes: [note],
    estimated_tier: null,
    confidence: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    model: "",
    provider: "",
  };
}

function buildUserMessage(input: LlmLayerInput): string {
  const fileLines = input.files
    .map((f) => `${f.path} (+${f.additions}/-${f.deletions})`)
    .join("\n");

  const diffHint = input.files
    .map((f) => {
      const added = f.patch
        .split("\n")
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
        .slice(0, 8)
        .join("\n");
      return `── ${f.path} ──\n${added}`;
    })
    .join("\n\n")
    .slice(0, 8000);

  const priorHints = input.prior_hints
    ? input.prior_hints
        .map((h) => `- ${h.layer}: risk=${h.risk}${h.notes ? ` (${h.notes.join("; ")})` : ""}`)
        .join("\n")
    : "(none)";

  return `Changed files:
${fileLines}

Prior-layer signals:
${priorHints}

Diff sample (first lines of each file):
${diffHint}

Classify into a single tier and respond with JSON only.`;
}
