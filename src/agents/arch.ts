/**
 * Architecture agent — assesses blast radius, change scope, and structural
 * concerns (cross-service contract changes, breaking-change risk, blast radius).
 */

import { ChangedFile, ArchAgentOutput, ArchAgentOutputSchema } from "../types/index.js";
import { runAgent, AgentRunResult } from "./runner.js";

const SYSTEM_PROMPT = `You are the architecture specialist for a fintech PR reviewer.

Scope:
- Blast radius (how many services / clients affected)
- Cross-service contract changes (public API shape, event schema, RPC)
- Breaking changes (removed fields, changed signatures, schema mods without migration)
- Coupling and dependency surface (new external deps, circular deps)
- Backward-compat issues

Blast radius levels:
- contained  — change affects only the file's package
- module     — change affects multiple files in one module/package
- service    — change affects the service's external contract (API/events)
- platform   — change affects multiple services or shared infrastructure

Out of scope:
- Security (covered by security agent)
- PCI compliance (covered by PCI agent)
- Style/naming opinions

Severity: info / warn / block.

Output STRICT JSON only:
{
  "agent": "arch",
  "summary": "≤200 chars",
  "findings": [
    { "path": "string", "line": <number, optional>, "severity": "info"|"warn"|"block", "category": "string", "message": "≤300 chars" }
  ],
  "blast_radius": "contained" | "module" | "service" | "platform",
  "blocks_merge": true | false
}`;

export async function runArchAgent(files: ChangedFile[]): Promise<AgentRunResult<ArchAgentOutput>> {
  return runAgent<ArchAgentOutput>({
    agentName: "arch",
    systemPrompt: SYSTEM_PROMPT,
    files,
    schema: ArchAgentOutputSchema,
    model: "sonnet",
    maxTokens: 1500,
  });
}
