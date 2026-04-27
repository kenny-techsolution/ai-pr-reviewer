/**
 * LlmClient — provider-agnostic interface for completing prompts that return
 * structured text (JSON for our use case).
 *
 * Two impls for Phase 1:
 *   - AnthropicClient   — uses @anthropic-ai/sdk (native messages API)
 *   - OpenAIClient      — uses openai SDK with configurable baseURL
 *                         (default points at OpenRouter)
 *
 * Phase 2 would add OpenAIClient pointed at api.openai.com directly,
 * BedrockClient for AWS-native deploys, and AzureOpenAIClient for enterprise.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ModelRole, Provider, priceCall, resolveModel } from "./models.js";

export interface LlmCallOptions {
  modelRole: ModelRole;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
}

export interface LlmCallResult {
  text: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  model_id: string;
  provider: Provider;
}

export interface LlmClient {
  readonly provider: Provider;
  complete(opts: LlmCallOptions): Promise<LlmCallResult>;
}

// =============================================================================
// AnthropicClient — direct, primary production path
// =============================================================================
export class AnthropicClient implements LlmClient {
  readonly provider: Provider = "anthropic";
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });
  }

  async complete(opts: LlmCallOptions): Promise<LlmCallResult> {
    const model = resolveModel(this.provider, opts.modelRole);
    const resp = await this.client.messages.create({
      model: model.id,
      max_tokens: opts.maxTokens ?? 1500,
      system: opts.systemPrompt,
      messages: [{ role: "user", content: opts.userMessage }],
    });
    const text = resp.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    return {
      text,
      tokens_in: resp.usage.input_tokens,
      tokens_out: resp.usage.output_tokens,
      cost_usd: priceCall(model, resp.usage.input_tokens, resp.usage.output_tokens),
      model_id: model.id,
      provider: this.provider,
    };
  }
}

// =============================================================================
// OpenAIClient — used for OpenRouter (or any OpenAI-compatible endpoint)
// =============================================================================
export interface OpenAIClientConfig {
  apiKey?: string;
  baseURL?: string;
  /** Optional headers OpenRouter uses for analytics. */
  appName?: string;
  appUrl?: string;
}

export class OpenAIClient implements LlmClient {
  readonly provider: Provider = "openrouter";
  private client: OpenAI;

  constructor(cfg: OpenAIClientConfig = {}) {
    const apiKey = cfg.apiKey ?? process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    this.client = new OpenAI({
      apiKey,
      baseURL: cfg.baseURL ?? "https://openrouter.ai/api/v1",
      defaultHeaders: {
        ...(cfg.appUrl ? { "HTTP-Referer": cfg.appUrl } : {}),
        ...(cfg.appName ? { "X-Title": cfg.appName } : { "X-Title": "SpotOn AI PR Reviewer" }),
      },
    });
  }

  async complete(opts: LlmCallOptions): Promise<LlmCallResult> {
    const model = resolveModel(this.provider, opts.modelRole);
    const resp = await this.client.chat.completions.create({
      model: model.id,
      max_tokens: opts.maxTokens ?? 1500,
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "user", content: opts.userMessage },
      ],
    });
    const text = resp.choices[0]?.message?.content ?? "";
    const tokens_in = resp.usage?.prompt_tokens ?? 0;
    const tokens_out = resp.usage?.completion_tokens ?? 0;
    return {
      text,
      tokens_in,
      tokens_out,
      cost_usd: priceCall(model, tokens_in, tokens_out),
      model_id: model.id,
      provider: this.provider,
    };
  }
}
