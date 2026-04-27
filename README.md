# AI PR Reviewer

Risk-tiered AI PR reviewer for fintech-grade engineering teams. Runs as a GitHub Action; classifies every PR into T0–T4 via a 4-layer signal stack and a 3-agent specialist swarm; posts reviews via the GitHub Reviews API; escalates T3 / T4 to Slack.

**Multi-provider:** the LLM adapter (`src/llm/`) supports Anthropic-direct OR OpenRouter for the underlying model calls. Anthropic is the production-recommended path; OpenRouter is the model-laboratory layer for evaluating non-Anthropic models (GPT-4o, Gemini, Llama, DeepSeek, Qwen) without onboarding a separate vendor relationship per model. See *Provider configuration* below.

## Architecture

```
PR diff (GitHub Action context)
        │
        ▼
┌─────────────────────────────────────────────────────┐
│ src/layers/                                         │
│  ├─ path.ts      → CODEOWNERS-style glob match     │
│  ├─ diff.ts      → migrations · secrets · deps     │
│  ├─ semantic.ts  → regex-based AST-like signals    │
│  └─ llm.ts       → Haiku classifier (ambiguous)    │
└─────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────┐
│ src/agents/  (parallel · structured JSON output)    │
│  ├─ security.ts  → Sonnet                          │
│  ├─ pci.ts       → Sonnet (Opus for T3 candidates) │
│  └─ arch.ts      → Sonnet                          │
└─────────────────────────────────────────────────────┘
        │
        ▼
src/aggregator.ts → Tier (T0–T4) + Decision + RiskReport
        │
        ▼
┌────────────────────┐  ┌────────────────────┐  ┌──────────────────┐
│ emitters/github.ts │  │ emitters/slack.ts  │  │ emitters/events  │
│ Reviews API post   │  │ Webhook · T3/T4    │  │ events.jsonl     │
└────────────────────┘  └────────────────────┘  └──────────────────┘
```

## Provider configuration

The reviewer auto-detects the LLM provider from environment:

| Env vars set | Provider used | Model IDs |
|---|---|---|
| `ANTHROPIC_API_KEY` only | Anthropic-direct | `claude-haiku-4-5` (classifier) · `claude-sonnet-4-6` (agents) · `claude-opus-4-7` (T3/T4 hard cases) |
| `OPENROUTER_API_KEY` only | OpenRouter | `anthropic/claude-haiku-4-5` · `anthropic/claude-sonnet-4-6` · `anthropic/claude-opus-4-7` |
| Both set | OpenRouter (auto), unless overridden | as above |

**Force a provider:** set `LLM_PROVIDER=anthropic` or `LLM_PROVIDER=openrouter`.

**Try a different model in any role:** set one or more of:

```bash
MODEL_CLASSIFIER=openai/gpt-4o-mini      # try GPT-4o-mini in the classifier slot
MODEL_AGENT=google/gemini-2.0-flash-exp  # try Gemini in the specialist agents
MODEL_AGENT_OPUS=anthropic/claude-opus-4-7
```

Model overrides force the provider chosen by your active key (typically OpenRouter, since OpenRouter is the way you'd access non-Anthropic models).

> **Production note:** OpenRouter is great for *experimentation* but routes traffic through a third-party aggregator. For PCI/SOC2 production traffic, prefer direct provider keys (`ANTHROPIC_API_KEY`, future `OPENAI_API_KEY` direct, future Bedrock client). The adapter is designed so production rollout = adding more clients in `src/llm/client.ts`, not a rewrite.

## Usage

In a GitHub Action:

```yaml
- name: AI PR Review
  run: npx tsx reviewer/src/cli.ts
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    # Pick ONE of these — both are supported:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    # OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
    # Slack webhooks — channel-routed (set the channel-specific ones in production):
    SLACK_WEBHOOK_PAYMENTS: ${{ secrets.SLACK_WEBHOOK_PAYMENTS }}
    SLACK_WEBHOOK_SECURITY: ${{ secrets.SLACK_WEBHOOK_SECURITY }}
    SLACK_WEBHOOK_URL:      ${{ secrets.SLACK_WEBHOOK_URL }}    # fallback / single-channel
```

Locally:

```bash
# Anthropic-direct
ANTHROPIC_API_KEY=… GITHUB_TOKEN=… npm run review -- --owner kenny-techsolution --repo pos-lite --pr 42

# OpenRouter (any model the OpenRouter catalog exposes)
OPENROUTER_API_KEY=… GITHUB_TOKEN=… npm run review -- --owner kenny-techsolution --repo pos-lite --pr 42

# Try GPT-4o-mini in the classifier role:
OPENROUTER_API_KEY=… MODEL_CLASSIFIER=openai/gpt-4o-mini GITHUB_TOKEN=… npm run review -- --owner kenny-techsolution --repo pos-lite --pr 42
```

## Tiers

| Tier | Meaning | AI behavior |
|---|---|---|
| **T0** | Docs · comments · formatter · test-only changes | Auto-approve · async sampled spot-check |
| **T1** | Low-risk UI · non-payment frontend | Approve · async human review within 24h, revertable |
| **T2** | Business logic · non-PCI backend | Comment + risk report · 1 human signoff required |
| **T3** | Payments · auth · KYC · crypto · PCI-scoped | Risk report only — **AI never approves** · senior + domain owner signoff required |
| **T4** | Direct prod-DB schema on payment tables · IAM widening · CI/CD bypass | Risk report + **hard block** · must restructure |

The **principal thesis**: *AI is not the gatekeeper. GitHub branch protection + `CODEOWNERS` are.* The reviewer is one signal in a system engineered so unsafe merges are structurally impossible — not merely discouraged.
