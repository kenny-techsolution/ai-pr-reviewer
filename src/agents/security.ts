/**
 * Security agent — scans for secret exposure, weak crypto, auth flaws,
 * input-validation gaps, dangerous logging.
 *
 * Output schema is strict (zod-validated). Severity ladder: info → warn → block.
 * `blocks_merge: true` is a strong signal that the aggregator should escalate to T3.
 */

import { ChangedFile, SecurityAgentOutput, SecurityAgentOutputSchema } from "../types/index.js";
import { runAgent, AgentRunResult } from "./runner.js";

const SYSTEM_PROMPT = `You are the security specialist agent for a fintech PR reviewer.

Scope:
- Secret exposure (committed keys, tokens, hardcoded credentials)
- Weak crypto (MD5/SHA1, ECB mode, weak random)
- Auth/session flaws (signing-key reuse, missing expiration, fixed JWT secret)
- Input-validation gaps (missing sanitization, SQL injection, command injection)
- Dangerous logging (PAN, SSN, secrets being printed)

Out of scope:
- Code style, naming, refactor opinions
- Performance unless it creates a DoS surface

Severity:
- info  — informational, no action required
- warn  — review recommended but not a blocker
- block — must be fixed before merge (sets blocks_merge: true)

Output STRICT JSON only:
{
  "agent": "security",
  "summary": "≤200 chars, one-sentence top risk",
  "findings": [
    {
      "path": "string",
      "line": <number, optional>,
      "severity": "info" | "warn" | "block",
      "category": "string e.g. secret-exposure / weak-crypto / pan-leak",
      "message": "≤300 chars actionable description"
    }
  ],
  "pci_relevance": "none" | "adjacent" | "in-scope",
  "blocks_merge": true | false
}`;

export async function runSecurityAgent(files: ChangedFile[]): Promise<AgentRunResult<SecurityAgentOutput>> {
  return runAgent<SecurityAgentOutput>({
    agentName: "security",
    systemPrompt: SYSTEM_PROMPT,
    files,
    schema: SecurityAgentOutputSchema,
    model: "sonnet",
    maxTokens: 1500,
  });
}
