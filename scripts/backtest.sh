#!/usr/bin/env bash
# AI PR Reviewer · backtest harness
#
# Iterate the reviewer over a window of historical PRs from a public repo,
# write each event to a single JSONL, and enforce a hard cost cap.
#
# Usage:
#   scripts/backtest.sh --owner medusajs --repo medusa --limit 75 --since 90 \
#                       --budget 15 --max-files 40 \
#                       --out artifacts/backtest-events.jsonl
#
# Required env: GITHUB_TOKEN (for the reviewer's Octokit) — auto-populated from `gh auth token` if unset.
# Required env: ANTHROPIC_API_KEY (or OPENROUTER_API_KEY) for the LLM layers.

set -uo pipefail   # NB: no -e — we want a single PR failure to log + continue, not abort the run.

# ---------- defaults ----------
OWNER=""
REPO=""
LIMIT=50
SINCE_DAYS=90
BUDGET=15.00
MAX_FILES=40
OUT="artifacts/backtest-events.jsonl"
SKIP_EXISTING=0

# ---------- arg parse ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner)         OWNER="$2";          shift 2 ;;
    --repo)          REPO="$2";           shift 2 ;;
    --limit)         LIMIT="$2";          shift 2 ;;
    --since)         SINCE_DAYS="$2";     shift 2 ;;
    --budget)        BUDGET="$2";         shift 2 ;;
    --max-files)     MAX_FILES="$2";      shift 2 ;;
    --out)           OUT="$2";            shift 2 ;;
    --skip-existing) SKIP_EXISTING=1;     shift ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$OWNER" ]] || [[ -z "$REPO" ]]; then
  echo "usage: $0 --owner X --repo Y [--limit 50] [--since 90] [--budget 15] [--max-files 40] [--out path] [--skip-existing]"
  exit 1
fi

# ---------- env sanity ----------
: "${GITHUB_TOKEN:=$(gh auth token 2>/dev/null || echo "")}"
if [[ -z "$GITHUB_TOKEN" ]]; then
  echo "✗ GITHUB_TOKEN not set and 'gh auth token' returned empty. Authenticate gh first."
  exit 1
fi
export GITHUB_TOKEN

if [[ -z "${ANTHROPIC_API_KEY:-}" ]] && [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "✗ Neither ANTHROPIC_API_KEY nor OPENROUTER_API_KEY is set. The LLM layer needs one."
  exit 1
fi

mkdir -p "$(dirname "$OUT")"

# ---------- existing-event skip set ----------
# (bash 3.2 doesn't have associative arrays — use a tempfile + grep -Fxq).
EXISTING_FILE=$(mktemp)
trap 'rm -f "$EXISTING_FILE"' EXIT
if [[ "$SKIP_EXISTING" -eq 1 ]] && [[ -f "$OUT" ]]; then
  while IFS= read -r line; do
    pr=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('pr_id',''))")
    [[ -n "$pr" ]] && echo "$pr" >> "$EXISTING_FILE"
  done < "$OUT"
  echo "↺ resume mode: skipping $(wc -l < "$EXISTING_FILE" | tr -d ' ') PRs already in $OUT"
fi

# ---------- list PRs (with retry for transient GitHub 5xx) ----------
SINCE_DATE=$(date -u -v -"${SINCE_DAYS}"d "+%Y-%m-%d" 2>/dev/null || date -u -d "${SINCE_DAYS} days ago" "+%Y-%m-%d")
echo "▶ listing closed PRs from $OWNER/$REPO since $SINCE_DATE (limit $LIMIT)"

FETCH=$((LIMIT * 3))
PR_LIST=""
for attempt in 1 2 3 4 5; do
  if PR_LIST=$(gh pr list --repo "$OWNER/$REPO" --state closed --limit "$FETCH" \
       --json number,title,changedFiles,mergedAt,createdAt \
       --jq ".[] | select(.changedFiles <= $MAX_FILES) | \"\(.number)\t\(.changedFiles)\t\(.title[0:70])\"" 2>/dev/null); then
    if [[ -n "$PR_LIST" ]]; then break; fi
  fi
  PR_LIST=""
  echo "  attempt $attempt failed — retrying in $((attempt * 3))s…"
  sleep $((attempt * 3))
done

if [[ -z "$PR_LIST" ]]; then
  echo "✗ gh pr list failed after retries"
  exit 1
fi

# ---------- loop ----------
TOTAL_COST_CENTS=0
TOTAL_PROCESSED=0
TOTAL_SKIPPED=0
TOTAL_FAILED=0
RUN_START=$(date +%s)

while IFS=$'\t' read -r PR_NUM CHANGED_FILES PR_TITLE; do
  if [[ "$TOTAL_PROCESSED" -ge "$LIMIT" ]]; then break; fi

  if [[ -s "$EXISTING_FILE" ]] && grep -Fxq "$PR_NUM" "$EXISTING_FILE"; then
    TOTAL_SKIPPED=$((TOTAL_SKIPPED + 1))
    continue
  fi

  RUNNING_COST=$(python3 -c "print(f'{$TOTAL_COST_CENTS / 100:.4f}')")
  printf "[%2d/%-2d] PR#%-6s · %sf · cumul \$%s · " \
    "$((TOTAL_PROCESSED + 1))" "$LIMIT" "$PR_NUM" "$CHANGED_FILES" "$RUNNING_COST"

  # Hard budget cap — abort if next PR could push us over.
  if (( $(echo "$RUNNING_COST > $BUDGET" | bc -l) )); then
    echo ""
    echo "✗ Hard cost cap of \$$BUDGET reached. Stopping at $TOTAL_PROCESSED PRs."
    break
  fi

  # One-PR run, capture event line, no GitHub/Slack posts.
  rm -f artifacts/events.jsonl
  if npx tsx src/cli.ts --owner "$OWNER" --repo "$REPO" --pr "$PR_NUM" --dry-run > /tmp/bt-stdout.log 2> /tmp/bt-stderr.log; then
    if [[ -f artifacts/events.jsonl ]]; then
      cat artifacts/events.jsonl >> "$OUT"
      LINE=$(tail -1 artifacts/events.jsonl)
      TIER=$(echo "$LINE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['ai_tier'])")
      COST=$(echo "$LINE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['cost_usd'])")
      LATENCY_MS=$(echo "$LINE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['latency_ms'])")
      printf "%s · \$%.4f · %ss · %s\n" "$TIER" "$COST" "$(echo "scale=1; $LATENCY_MS/1000" | bc)" "${PR_TITLE:0:50}"
      # add to running total in cents (×100, integer math is reliable)
      COST_CENTS=$(echo "$COST * 100" | bc -l | awk '{printf "%.0f", $1}')
      TOTAL_COST_CENTS=$((TOTAL_COST_CENTS + COST_CENTS))
      TOTAL_PROCESSED=$((TOTAL_PROCESSED + 1))
    else
      echo "FAIL · no event file produced"
      TOTAL_FAILED=$((TOTAL_FAILED + 1))
    fi
  else
    echo "FAIL · reviewer exit $?"
    tail -3 /tmp/bt-stderr.log | sed 's/^/    /'
    TOTAL_FAILED=$((TOTAL_FAILED + 1))
  fi

  # Polite rate-limit pacing — well under GitHub's 5000/hr authenticated.
  sleep 1
done <<< "$PR_LIST"

ELAPSED=$(($(date +%s) - RUN_START))
FINAL_COST=$(python3 -c "print(f'{$TOTAL_COST_CENTS / 100:.4f}')")

echo ""
echo "════════════════════════════════════════════════════"
echo "  Backtest complete"
echo "════════════════════════════════════════════════════"
echo "  Repo:       $OWNER/$REPO"
echo "  Window:     last $SINCE_DAYS days"
echo "  Processed:  $TOTAL_PROCESSED PRs"
echo "  Skipped:    $TOTAL_SKIPPED PRs (resume cache)"
echo "  Failed:     $TOTAL_FAILED PRs"
echo "  Cost:       \$$FINAL_COST"
echo "  Wall time:  $((ELAPSED / 60))m $((ELAPSED % 60))s"
echo "  Output:     $OUT ($(wc -l < "$OUT" | tr -d ' ') lines)"
echo "════════════════════════════════════════════════════"
