/**
 * Specialist agent runner — shared infrastructure for security/pci/arch agents.
 *
 * Each agent provides a system prompt + a zod schema for its output. The runner
 * delegates to the LlmClient adapter (Anthropic-direct or OpenRouter, chosen
 * by env), validates the JSON, and returns a result with cost accounting.
 */

import { type ZodSchema } from "zod";
import { ChangedFile } from "../types/index.js";
import { extractJson, getClient } from "../llm/index.js";
import { ModelRole } from "../llm/models.js";

export type ModelChoice = "sonnet" | "opus";

export interface AgentRunInput<T> {
  agentName: string;
  systemPrompt: string;
  files: ChangedFile[];
  schema: ZodSchema<T>;
  model?: ModelChoice;
  maxTokens?: number;
}

export interface AgentRunResult<T> {
  output: T | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  model: string;
  provider: string;
  error?: string;
}

const MODEL_TO_ROLE: Record<ModelChoice, ModelRole> = {
  sonnet: "agent",
  opus: "agent-opus",
};

export async function runAgent<T>(input: AgentRunInput<T>): Promise<AgentRunResult<T>> {
  // Get the configured client (Anthropic or OpenRouter)
  let client;
  try {
    client = getClient();
  } catch (err) {
    return {
      output: null, tokens_in: 0, tokens_out: 0, cost_usd: 0,
      model: "", provider: "",
      error: `${input.agentName} agent skipped — ${(err as Error).message}`,
    };
  }

  const role = MODEL_TO_ROLE[input.model ?? "sonnet"];
  const userMsg = buildUserMessage(input.files);

  try {
    const result = await client.complete({
      modelRole: role,
      systemPrompt: input.systemPrompt,
      userMessage: userMsg,
      maxTokens: input.maxTokens ?? 1500,
    });
    const parsed = input.schema.parse(JSON.parse(extractJson(result.text)));
    return {
      output: parsed,
      tokens_in: result.tokens_in,
      tokens_out: result.tokens_out,
      cost_usd: result.cost_usd,
      model: result.model_id,
      provider: result.provider,
    };
  } catch (err) {
    return {
      output: null, tokens_in: 0, tokens_out: 0, cost_usd: 0,
      model: "", provider: client.provider,
      error: `${input.agentName} agent failure: ${(err as Error).message}`,
    };
  }
}

function buildUserMessage(files: ChangedFile[]): string {
  const fileLines = files.map((f) => `${f.path} (+${f.additions}/-${f.deletions})`).join("\n");

  const diffs = files
    .map((f) => {
      const added = f.patch
        .split("\n")
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
        .slice(0, 60)
        .map((l) => l.slice(1))
        .join("\n");
      return `── ${f.path} ──\n${added}`;
    })
    .join("\n\n")
    .slice(0, 12000);

  return `Changed files:
${fileLines}

Added/changed code:
${diffs}

Respond with JSON only — strict schema as specified in the system prompt.`;
}
