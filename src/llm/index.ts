/**
 * Barrel + provider factory.
 *
 * Provider selection precedence (read at first call):
 *   1. LLM_PROVIDER=anthropic   + ANTHROPIC_API_KEY  → AnthropicClient
 *   2. LLM_PROVIDER=openrouter  + OPENROUTER_API_KEY → OpenAIClient(OpenRouter)
 *   3. Auto: OPENROUTER_API_KEY set                  → OpenAIClient(OpenRouter)
 *   4. Auto: ANTHROPIC_API_KEY  set                  → AnthropicClient
 *   5. Else                                          → throw with setup message
 *
 * Override of model IDs (without changing provider): set MODEL_CLASSIFIER /
 * MODEL_AGENT / MODEL_AGENT_OPUS to provider-appropriate IDs.
 *
 * The factory caches the client so multiple call sites share one connection.
 */

import { AnthropicClient, LlmClient, OpenAIClient } from "./client.js";

export * from "./client.js";
export * from "./models.js";
export * from "./json.js";

let cached: LlmClient | null = null;

export function getClient(): LlmClient {
  if (cached) return cached;

  const explicit = (process.env.LLM_PROVIDER ?? "").toLowerCase().trim();
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);

  // 1 + 2: explicit selection
  if (explicit === "anthropic") {
    if (!hasAnthropic) throw new Error("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set");
    cached = new AnthropicClient();
    return cached;
  }
  if (explicit === "openrouter") {
    if (!hasOpenRouter) throw new Error("LLM_PROVIDER=openrouter but OPENROUTER_API_KEY is not set");
    cached = new OpenAIClient();
    return cached;
  }
  if (explicit && explicit !== "anthropic" && explicit !== "openrouter") {
    throw new Error(`Unknown LLM_PROVIDER=${explicit}. Expected "anthropic" or "openrouter".`);
  }

  // 3 + 4: auto-detect
  if (hasOpenRouter) {
    cached = new OpenAIClient();
    return cached;
  }
  if (hasAnthropic) {
    cached = new AnthropicClient();
    return cached;
  }

  // 5: nothing set
  throw new Error(
    "No LLM provider available. Set ANTHROPIC_API_KEY (direct) or OPENROUTER_API_KEY (multi-provider via OpenRouter). " +
      "Optionally set LLM_PROVIDER=anthropic|openrouter to override auto-detection.",
  );
}

/** Reset the cached client — used by tests that swap env vars between cases. */
export function resetClient(): void {
  cached = null;
}
