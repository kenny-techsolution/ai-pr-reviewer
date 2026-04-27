/**
 * Smoke test — runs the layer stack + aggregator against a synthetic PRContext
 * with no external calls. Validates that the deterministic pipeline produces
 * a coherent Decision for each tier band.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runLayerStack } from "../src/layers/index.js";
import { aggregate } from "../src/aggregator.js";
import { ChangedFile, PRContext } from "../src/types/index.js";

function fakePR(files: ChangedFile[], title = "Test PR"): PRContext {
  return {
    owner: "test", repo: "pos-lite", prNumber: 1, title, body: "",
    baseRef: "main", headRef: "feature", headSha: "abc123",
    author: "alice", files,
  };
}

function fakeFile(path: string, addedContent: string, additions = 5, deletions = 0): ChangedFile {
  const patch = `@@ -1,1 +1,${additions} @@\n` + addedContent.split("\n").map((l) => `+${l}`).join("\n");
  return { path, additions, deletions, patch, status: "modified" };
}

test("T0 docs change → APPROVE", async () => {
  const files = [fakeFile("docs/README.md", "Updated documentation")];
  const layers = await runLayerStack(files);
  const decision = aggregate({ ctx: fakePR(files), layers, agents: [] });
  assert.equal(decision.tier, "T0");
  assert.equal(decision.action, "APPROVE");
  assert.equal(decision.escalate_slack, false);
});

test("T1 web component change → APPROVE", async () => {
  const files = [fakeFile("web/src/components/Cart.tsx", "export function Cart() { return null }")];
  const layers = await runLayerStack(files);
  const decision = aggregate({ ctx: fakePR(files), layers, agents: [] });
  assert.equal(decision.tier, "T1");
  assert.equal(decision.action, "APPROVE");
});

test("T2 backend logic change → COMMENT", async () => {
  const files = [fakeFile("api/orders/service.go", "func ComputeTotals(o *Order) error { return nil }")];
  const layers = await runLayerStack(files);
  const decision = aggregate({ ctx: fakePR(files), layers, agents: [] });
  assert.equal(decision.tier, "T2");
  assert.equal(decision.action, "COMMENT");
});

test("T3 payments change → REQUEST_CHANGES + Slack", async () => {
  const files = [fakeFile("api/payments/charge.go", "func HandleCharge(w http.ResponseWriter, r *http.Request) {\n\tprocessor := os.Getenv(\"PAYMENT_PROCESSOR_API_KEY\")\n}")];
  const layers = await runLayerStack(files);
  const decision = aggregate({ ctx: fakePR(files), layers, agents: [] });
  assert.equal(decision.tier, "T3");
  assert.equal(decision.action, "REQUEST_CHANGES");
  assert.equal(decision.escalate_slack, true);
  assert.equal(decision.slack_channel, "#payments-review");
});

test("T4 migration on payments table → REQUEST_CHANGES + Slack", async () => {
  const files = [fakeFile(
    "migrations/20260404_add_column_payments.sql",
    "ALTER TABLE payments ADD COLUMN settlement_batch_id BIGINT NOT NULL DEFAULT 0;",
  )];
  const layers = await runLayerStack(files);
  const decision = aggregate({ ctx: fakePR(files), layers, agents: [] });
  assert.equal(decision.tier, "T4");
  assert.equal(decision.action, "REQUEST_CHANGES");
  assert.equal(decision.escalate_slack, true);
});

test("auth path → T3 → routes Slack to #security", async () => {
  const files = [fakeFile("api/auth/jwt.go", "func IssueJWT(userID, role string) (string, error) {\n\thmac.New(sha256.New, []byte(secret))\n}")];
  const layers = await runLayerStack(files);
  const decision = aggregate({ ctx: fakePR(files), layers, agents: [] });
  assert.equal(decision.tier, "T3");
  assert.equal(decision.slack_channel, "#security");
});

test("layer stack records signals on every layer", async () => {
  const files = [fakeFile("api/payments/charge.go", "math.Round(amount * 100)")];
  const layers = await runLayerStack(files);
  assert.ok(layers.path.findings.length > 0, "path layer should fire");
  assert.ok(layers.semantic.findings.length > 0, "semantic layer should fire");
});

test("review body always includes the principal thesis line", async () => {
  const files = [fakeFile("api/payments/charge.go", "x := 1")];
  const layers = await runLayerStack(files);
  const decision = aggregate({ ctx: fakePR(files), layers, agents: [] });
  assert.ok(decision.body.includes("AI is not the gatekeeper"), "review body should include the thesis");
});
