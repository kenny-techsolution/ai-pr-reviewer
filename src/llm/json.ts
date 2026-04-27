/**
 * Extract a JSON object from a model response that may wrap it in markdown
 * fences or return prose around it. Shared by all LLM-calling code paths.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(trimmed);
  if (fence && fence[1]) return fence[1];
  const obj = /\{[\s\S]*\}/.exec(trimmed);
  return obj ? obj[0] : trimmed;
}
