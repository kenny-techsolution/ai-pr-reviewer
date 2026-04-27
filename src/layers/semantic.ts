/**
 * Layer 3: semantic signals — pattern matching at a "shape" level inside the
 * added lines of the diff.
 *
 * Pragmatic note: production version uses tree-sitter for proper AST queries.
 * For 2-day demo we use focused regex against the added/changed lines, which
 * is adequate for the patterns we care about (calls to payment APIs, env-secret
 * reads, crypto primitives, money-rounding bugs). Upgrade path is documented
 * in `docs/specs/2026-04-24-pr-reviewer-design.md` § 4.1 layer 3.
 */

import {
  ChangedFile,
  LayerSignal,
  RiskLevel,
  SignalFinding,
  maxRisk,
} from "../types/index.js";

interface SemanticRule {
  id: string;
  pattern: RegExp;
  risk: RiskLevel;
  rationale: string;
  /** If set, only run on file paths matching this regex. */
  pathHint?: RegExp;
}

const SEMANTIC_RULES: SemanticRule[] = [
  // payment-API call surfaces
  { id: "calls-payment-handler", pattern: /\b(payments\.\w+|HandleCharge|HandleRefund|submitToProcessor|submitRefundToProcessor)\b/,
    risk: "high", rationale: "Calls a payment-handling function" },

  // money math — float for currency is a classic bug
  { id: "float-money", pattern: /\bfloat(32|64)\s+\w*(amount|price|total|cost|fee|tax)\w*\b|\b(amount|price|total|cost|fee|tax)\w*\s+float(32|64)\b/i,
    risk: "high", rationale: "Floating-point variable used for money — should be int64 cents" },

  // env-secret reading
  { id: "env-secret-read", pattern: /(os\.Getenv|process\.env\.)\(?["']?[A-Z_]*(SECRET|KEY|TOKEN|PASSWORD|API_KEY)[A-Z_]*/i,
    risk: "medium", rationale: "Reads a secret from environment — verify it's not logged" },

  // raw PAN handling
  { id: "raw-pan", pattern: /\b(card_number|pan|raw_card)\b/i,
    risk: "critical", rationale: "Possible raw card-number reference — must use tokenized card data" },

  // jwt signing / verification
  { id: "jwt-handling", pattern: /\b(IssueJWT|VerifyJWT|jwt\.sign|jwt\.verify|hmac\.New)\b/,
    risk: "high", rationale: "JWT signing or verification — security-sensitive" },

  // sql in payment package
  { id: "sql-in-payments", pattern: /\b(BEGIN|ALTER|CREATE\s+INDEX|DELETE\s+FROM|UPDATE)\b/i,
    risk: "high", rationale: "SQL statement appears in PR — review for race / lock implications",
    pathHint: /(payments|billing|migrations)\//i },

  // weak crypto
  { id: "weak-crypto", pattern: /\b(md5|sha1)\b|crypto\.createHash\(["'](md5|sha1)["']\)/i,
    risk: "high", rationale: "Weak cryptographic hash (MD5 / SHA1) used — prefer SHA-256 or stronger" },

  // hardcoded URL with creds
  { id: "url-with-creds", pattern: /https?:\/\/[^\s:@]+:[^\s@]+@/,
    risk: "critical", rationale: "URL contains embedded credentials" },

  // fmt.Println / console.log of sensitive-named vars
  { id: "log-of-secret", pattern: /(fmt\.Println|console\.log|log\.\w+)\s*\([^)]*(token|secret|key|pan|ssn|tax_id)\b[^)]*\)/i,
    risk: "high", rationale: "Logging a sensitive-looking variable" },

  // rounding logic
  { id: "rounding-money", pattern: /\b(math\.Round|Math\.round)\(.*\b(amount|price|total)\b/i,
    risk: "medium", rationale: "Rounding logic on monetary value — verify banker's rounding rule" },
];

export interface SemanticLayerResult extends LayerSignal {}

export function runSemanticLayer(files: ChangedFile[]): SemanticLayerResult {
  const findings: SignalFinding[] = [];
  let highest: RiskLevel = "none";

  for (const file of files) {
    const addedLines = extractAddedLines(file.patch);

    for (const rule of SEMANTIC_RULES) {
      if (rule.pathHint && !rule.pathHint.test(file.path)) continue;

      for (const { line, content } of addedLines) {
        if (rule.pattern.test(content)) {
          findings.push({
            path: file.path,
            rule: `semantic:${rule.id}`,
            risk: rule.risk,
            detail: rule.rationale,
            line,
          });
          highest = maxRisk(highest, rule.risk);
          // one match per rule per file is enough — break inner loop
          break;
        }
      }
    }
  }

  return {
    risk: highest,
    findings,
    notes: [`${findings.length} semantic finding(s) across ${files.length} file(s)`],
  };
}

/**
 * Extract added lines (`+` prefix) from a unified-diff patch, with their
 * approximate line number in the new file.
 */
function extractAddedLines(patch: string): { line: number; content: string }[] {
  const out: { line: number; content: string }[] = [];
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)/.exec(raw);
    if (hunk && hunk[1]) {
      newLine = parseInt(hunk[1], 10) - 1;
      continue;
    }
    if (raw.startsWith("+++")) continue;
    if (raw.startsWith("---")) continue;
    if (raw.startsWith("+")) {
      newLine++;
      out.push({ line: newLine, content: raw.slice(1) });
    } else if (!raw.startsWith("-")) {
      newLine++;
    }
  }
  return out;
}
