#!/usr/bin/env bash
# Reseed the dashboard R2 events.jsonl with the union of:
#   - existing live events from pos-lite (whatever's in R2 today)
#   - the new backtest events
#
# Idempotent: re-running with a different backtest file replaces the
# previous backtest run cleanly without disturbing live events.
#
# Usage:
#   CF_WRITE_TOKEN=… scripts/reseed-r2.sh \
#     --backtest artifacts/backtest-events.gt.jsonl \
#     --backtest-repo medusajs/medusa
#
# Required env: CF_WRITE_TOKEN — the Cloudflare Worker write token (same one
# pos-lite's GitHub Action uses; see ai-review-dashboard/worker/README.md).

set -uo pipefail

WORKER_URL="https://ai-review-events.kenny-techsolution.workers.dev"
BACKTEST_FILE=""
BACKTEST_REPO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backtest)      BACKTEST_FILE="$2"; shift 2 ;;
    --backtest-repo) BACKTEST_REPO="$2"; shift 2 ;;
    --worker-url)    WORKER_URL="$2";    shift 2 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$BACKTEST_FILE" ]] || [[ ! -f "$BACKTEST_FILE" ]]; then
  echo "✗ --backtest <file> is required and must exist"
  exit 1
fi
if [[ -z "$BACKTEST_REPO" ]]; then
  echo "✗ --backtest-repo <owner/repo> is required (used to deduplicate prior backtest events)"
  exit 1
fi
if [[ -z "${CF_WRITE_TOKEN:-}" ]]; then
  echo "✗ CF_WRITE_TOKEN is not set"
  exit 1
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# 1. Fetch current R2 contents
echo "▶ fetching current R2 events…"
CURRENT=$(curl -sS "$WORKER_URL/events.jsonl?cb=$(date +%s)")
CURRENT_COUNT=$(echo -n "$CURRENT" | wc -l | tr -d ' ')
echo "  current: $CURRENT_COUNT lines"

# 2. Filter out prior runs of THIS backtest repo (so re-runs are idempotent).
# CRITICAL: stdout becomes the merged events file — never let log lines bleed
# into it. Python writes data to stdout, status to stderr; we only capture stdout.
echo "▶ filtering out prior $BACKTEST_REPO events…"
echo "$CURRENT" | python3 -c "
import sys, json
target = '$BACKTEST_REPO'
kept = 0
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        obj = json.loads(line)
        if obj.get('repo') == target: continue
        sys.stdout.write(line + '\n')
        kept += 1
    except Exception: continue
sys.stderr.write(f'kept {kept} non-{target} events\n')
" > "$TMP"

KEPT=$(grep -c "^{" "$TMP" || echo 0)
echo "  kept: $KEPT non-$BACKTEST_REPO events"

# 3. Append the backtest file
echo "▶ appending backtest events…"
NEW_COUNT=$(grep -c "^{" "$BACKTEST_FILE" || echo 0)
cat "$BACKTEST_FILE" >> "$TMP"
TOTAL=$(grep -c "^{" "$TMP")
echo "  total after merge: $TOTAL lines"

# 4. PUT to Worker
echo "▶ uploading to $WORKER_URL/events…"
HTTP_CODE=$(curl -sS -o /tmp/reseed-resp.txt -w "%{http_code}" \
  -X PUT "$WORKER_URL/events" \
  -H "Authorization: Bearer $CF_WRITE_TOKEN" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary "@$TMP")

if [[ "$HTTP_CODE" -ge 200 ]] && [[ "$HTTP_CODE" -lt 300 ]]; then
  echo "  ✓ HTTP $HTTP_CODE · response: $(cat /tmp/reseed-resp.txt)"
else
  echo "  ✗ HTTP $HTTP_CODE · response: $(cat /tmp/reseed-resp.txt)"
  exit 1
fi

# 5. Verify by fetching back
VERIFY=$(curl -sS "$WORKER_URL/events.jsonl?cb=$(date +%s)" | wc -l | tr -d ' ')
echo "  ✓ R2 now reports $VERIFY lines"

echo ""
echo "════════════════════════════════════════════════════"
echo "  Reseed complete"
echo "════════════════════════════════════════════════════"
echo "  Live events kept:    $KEPT"
echo "  Backtest events new: $NEW_COUNT"
echo "  Total in R2:         $VERIFY"
echo "  Dashboard URL:       https://kenny-techsolution.github.io/ai-review-dashboard/"
echo "════════════════════════════════════════════════════"
