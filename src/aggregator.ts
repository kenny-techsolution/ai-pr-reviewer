/**
 * Aggregator — turns layer signals + agent outputs into a final Decision.
 *
 * Deterministic by design: the agents make recommendations, but the
 * aggregator's tier-decision rules are pure code. This is the layer where
 * a future audit asks "show me how that PR was classified" and gets a
 * straight-line answer with no LLM hand-waving.
 */

import {
  AgentOutput,
  ChangedFile,
  Decision,
  PRContext,
  Tier,
  tierAction,
  tierIdx,
  tierMeaning,
} from "./types/index.js";
import { LayerStackResult } from "./layers/index.js";

export interface AggregatorInput {
  ctx: PRContext;
  layers: LayerStackResult;
  agents: AgentOutput[]; // empty allowed
}

export function aggregate(input: AggregatorInput): Decision {
  const { ctx, layers, agents } = input;

  const ruleMatches: string[] = [];
  let tier: Tier = "T0";

  // === Rule 1: any T4 path triggers T4 immediately ===
  if (layers.path.highest_tier === "T4") {
    tier = "T4";
    ruleMatches.push("R1: T4 path matched");
  }

  // === Rule 2: critical diff signal (DROP, NOT NULL without DEFAULT, IAM widening) → T4 ===
  if (layers.diff.findings.some((f) => f.risk === "critical")) {
    if (tierIdx(tier) < tierIdx("T4")) {
      tier = "T4";
      ruleMatches.push("R2: critical diff signal → T4");
    }
  }

  // === Rule 3: T3 path match → at least T3 ===
  if (layers.path.highest_tier === "T3" && tierIdx(tier) < tierIdx("T3")) {
    tier = "T3";
    ruleMatches.push("R3: T3 path matched");
  }

  // === Rule 4: PCI agent says in-scope → at least T3 ===
  const pciAgent = agents.find((a) => a.agent === "pci");
  if (pciAgent && pciAgent.scope_assessment === "pci-in-scope") {
    if (tierIdx(tier) < tierIdx("T3")) {
      tier = "T3";
      ruleMatches.push("R4: PCI agent says in-scope → T3");
    }
  }

  // === Rule 5: PCI agent recommends a higher tier → use it ===
  if (pciAgent && tierIdx(pciAgent.recommended_tier) > tierIdx(tier)) {
    tier = pciAgent.recommended_tier;
    ruleMatches.push(`R5: PCI agent recommends ${pciAgent.recommended_tier}`);
  }

  // === Rule 6: any agent blocks merge → at least T3 ===
  if (agents.some((a) => a.blocks_merge) && tierIdx(tier) < tierIdx("T3")) {
    tier = "T3";
    ruleMatches.push("R6: agent blocks_merge → T3");
  }

  // === Rule 7: semantic high-risk findings (raw PAN, weak crypto) → at least T3 ===
  if (
    layers.semantic.findings.some((f) => f.risk === "critical" || f.risk === "high") &&
    tierIdx(tier) < tierIdx("T3")
  ) {
    tier = "T3";
    ruleMatches.push("R7: high-risk semantic finding → T3");
  }

  // === Rule 8: LLM classifier with high confidence → respect ===
  if (layers.llm && layers.llm.estimated_tier && layers.llm.confidence >= 0.7) {
    if (tierIdx(layers.llm.estimated_tier) > tierIdx(tier)) {
      tier = layers.llm.estimated_tier;
      ruleMatches.push(`R8: LLM (conf ${layers.llm.confidence.toFixed(2)}) → ${layers.llm.estimated_tier}`);
    }
  }

  // === Rule 9: fallback to path tier if nothing else triggered ===
  if (tier === "T0" && layers.path.highest_tier) {
    tier = layers.path.highest_tier;
    ruleMatches.push(`R9: fallback to path tier ${layers.path.highest_tier}`);
  }

  const action = tierAction[tier];
  const body = buildReviewBody(tier, layers, agents, ruleMatches);
  const comments = collectLineComments(layers, agents);
  const escalate_slack = tier === "T3" || tier === "T4";
  const slack_channel = escalate_slack ? pickSlackChannel(input.ctx.files) : undefined;
  const top_risks = pickTopRisks(layers, agents).slice(0, 3);

  return {
    tier,
    action,
    body,
    comments,
    escalate_slack,
    ...(slack_channel ? { slack_channel } : {}),
    top_risks,
    reasoning: {
      layer_signals: {
        path:     { risk: layers.path.risk,     findings: layers.path.findings, ...(layers.path.notes ? { notes: layers.path.notes } : {}) },
        diff:     { risk: layers.diff.risk,     findings: layers.diff.findings, ...(layers.diff.notes ? { notes: layers.diff.notes } : {}) },
        semantic: { risk: layers.semantic.risk, findings: layers.semantic.findings, ...(layers.semantic.notes ? { notes: layers.semantic.notes } : {}) },
        ...(layers.llm
          ? { llm: { risk: layers.llm.risk, findings: layers.llm.findings, ...(layers.llm.notes ? { notes: layers.llm.notes } : {}) } }
          : {}),
      },
      agent_outputs: agents,
      rule_matches: ruleMatches,
    },
  };
}

function buildReviewBody(
  tier: Tier,
  layers: LayerStackResult,
  agents: AgentOutput[],
  rules: string[],
): string {
  const parts: string[] = [];

  parts.push(`### AI Reviewer · classified as **${tier}** — ${tierMeaning[tier]}`);
  parts.push("");

  // Action line (in plain English)
  switch (tier) {
    case "T0":
      parts.push(`**✅ Auto-approving** — docs/tests/formatter only, no human review needed.`);
      break;
    case "T1":
      parts.push(`**✅ Approving** — low-risk frontend. A human reviewer should glance at this within 24 h; revert if anything looks off.`);
      break;
    case "T2":
      parts.push(`**📝 Review needed** — non-PCI backend logic. Branch protection requires one human approver before merge.`);
      break;
    case "T3":
      parts.push(`**⛔ Senior + domain owner sign-off required** — PCI-scoped code. AI reviewer never auto-approves T3. Branch protection requires reviewers in the listed CODEOWNERS teams.`);
      break;
    case "T4":
      parts.push(`**🛑 Hard block — must restructure.** This change touches a path/pattern that should not be merged in its current form. See findings below.`);
      break;
  }

  // Top risks
  const topRisks = pickTopRisks(layers, agents).slice(0, 5);
  if (topRisks.length > 0) {
    parts.push("");
    parts.push(`#### Top concerns`);
    topRisks.forEach((r, i) => parts.push(`${i + 1}. ${r}`));
  }

  // Layer summary
  parts.push("");
  parts.push(`<details><summary>Signal stack details</summary>`);
  parts.push("");
  parts.push(`- **Path layer:** ${layers.path.risk}${layers.path.highest_tier ? ` (matched ${layers.path.highest_tier})` : ""}`);
  parts.push(`- **Diff heuristics:** ${layers.diff.risk} · ${layers.diff.findings.length} finding(s)`);
  parts.push(`- **Semantic layer:** ${layers.semantic.risk} · ${layers.semantic.findings.length} finding(s)`);
  if (layers.llm) {
    parts.push(`- **LLM classifier:** ${layers.llm.estimated_tier ?? "n/a"} (confidence ${layers.llm.confidence.toFixed(2)}) · ${layers.llm.tokens_in + layers.llm.tokens_out} tokens · $${layers.llm.cost_usd.toFixed(4)}`);
  }
  if (rules.length > 0) {
    parts.push("");
    parts.push(`Rules fired: ${rules.map((r) => `\`${r}\``).join(", ")}`);
  }
  parts.push(`</details>`);

  if (agents.length > 0) {
    parts.push("");
    parts.push(`<details><summary>Specialist agent reports</summary>`);
    parts.push("");
    for (const a of agents) {
      parts.push(`**${a.agent}** — ${a.summary}`);
      if (a.findings.length > 0) {
        a.findings.slice(0, 5).forEach((f) =>
          parts.push(`  - [${f.severity}] \`${f.path}${f.line ? `:${f.line}` : ""}\` · ${f.category} · ${f.message}`),
        );
      }
      parts.push("");
    }
    parts.push(`</details>`);
  }

  parts.push("");
  parts.push(`---`);
  parts.push(`> AI is not the gatekeeper. GitHub branch protection + \`CODEOWNERS\` are. This review is one signal in a system engineered so unsafe merges are structurally impossible.`);

  return parts.join("\n");
}

function collectLineComments(layers: LayerStackResult, agents: AgentOutput[]): Decision["comments"] {
  const out: Decision["comments"] = [];

  // Diff layer line comments — high/critical only
  for (const f of layers.diff.findings) {
    if (f.line && (f.risk === "high" || f.risk === "critical")) {
      out.push({
        path: f.path,
        line: f.line,
        body: `**${f.risk.toUpperCase()}** — ${f.detail ?? f.rule}`,
      });
    }
  }

  // Semantic layer
  for (const f of layers.semantic.findings) {
    if (f.line && (f.risk === "high" || f.risk === "critical")) {
      out.push({
        path: f.path,
        line: f.line,
        body: `**${f.risk.toUpperCase()}** — ${f.detail ?? f.rule}`,
      });
    }
  }

  // Agent findings with line info
  for (const a of agents) {
    for (const f of a.findings) {
      if (f.line) {
        out.push({
          path: f.path,
          line: f.line,
          body: `_${a.agent} agent_ · **${f.severity.toUpperCase()}** · ${f.category} — ${f.message}`,
        });
      }
    }
  }

  // De-duplicate — same path+line collapses to single comment
  const seen = new Map<string, (typeof out)[number]>();
  for (const c of out) {
    const k = `${c.path}:${c.line}`;
    if (!seen.has(k)) seen.set(k, c);
    else {
      const existing = seen.get(k)!;
      existing.body += `\n${c.body}`;
    }
  }
  return Array.from(seen.values()).slice(0, 20); // cap to prevent comment-spam
}

function pickSlackChannel(files: ChangedFile[]): string {
  const paths = files.map((f) => f.path);
  if (paths.some((p) => /\b(auth|crypto|jwt|secrets)\b/i.test(p))) return "#security";
  if (paths.some((p) => /\bpayments?\b/i.test(p))) return "#payments-review";
  if (paths.some((p) => /\bmigrations\b/i.test(p))) return "#payments-review";
  return "#eng-reviews";
}

function pickTopRisks(layers: LayerStackResult, agents: AgentOutput[]): string[] {
  const risks: { score: number; text: string }[] = [];
  const score = (r: string): number => ({ critical: 4, high: 3, medium: 2, low: 1, none: 0 } as Record<string, number>)[r] ?? 0;

  for (const f of layers.diff.findings) {
    if (f.risk !== "none" && f.risk !== "low") {
      risks.push({ score: score(f.risk), text: `\`${f.path}\` · ${f.detail ?? f.rule}` });
    }
  }
  for (const f of layers.semantic.findings) {
    if (f.risk !== "none" && f.risk !== "low") {
      risks.push({ score: score(f.risk), text: `\`${f.path}\` · ${f.detail ?? f.rule}` });
    }
  }
  for (const a of agents) {
    for (const f of a.findings) {
      if (f.severity === "block" || f.severity === "warn") {
        risks.push({ score: f.severity === "block" ? 5 : 3, text: `\`${f.path}\` · ${f.message}` });
      }
    }
  }

  return risks.sort((a, b) => b.score - a.score).map((r) => r.text);
}
