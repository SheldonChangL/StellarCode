#!/bin/sh
# v0.6 semantic graph holdout: one repository, baseline / stellar-lexical / stellar, Latin square.
# Usage: run-holdout.sh <repo> <out-stage> <modes> <repeat> [task-ids]
set -eu
REPO="$1"; STAGE="$2"; MODES="$3"; REPEAT="$4"; IDS="${5:-}"
STELLAR_ROOT=/Users/sheldon.chang/Projects/Private/StellarCode_M0-M3_Complete
HOLDOUT="${HOLDOUT_DIR:-/Users/sheldon.chang/Projects/Private/stellar-holdout-v06}"
WT="$HOLDOUT/$REPO"
TASKS="${TASKS_FILE:-$STELLAR_ROOT/validation/v0.6/tasksets/$REPO/tasks.json}"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$STELLAR_ROOT/validation/v0.6/$STAGE/$REPO/claude-$STAMP"
export STELLAR_DATA_DIR="$HOLDOUT/data/v06-$REPO-$STAMP"
export STELLAR_CACHE_DIR="$HOLDOUT/cache/v06-$REPO-$STAMP"
export STELLAR_LOG_DIR="$HOLDOUT/logs/v06-$REPO-$STAMP"

# Frozen task set, clean worktree at its fixed commit, committed runtime.
if [ -z "${TASKS_FILE:-}" ]; then (cd "$(dirname "$TASKS")" && shasum -a 256 -c TASKSET.sha256); fi
test -z "$(git -C "$WT" status --porcelain | grep -v '^?? .stellar/$' || true)"
test -z "$(git -C "$STELLAR_ROOT" status --porcelain -- src bin package.json)"

mkdir -p "$OUT"
{
  echo "repo=$REPO stage=$STAGE modes=$MODES repeat=$REPEAT taskIds=$IDS"
  echo "repoCommit=$(git -C "$WT" rev-parse HEAD)"
  echo "stellarCommit=$(git -C "$STELLAR_ROOT" rev-parse HEAD)"
} > "$OUT/campaign.env"
node "$STELLAR_ROOT/bin/stellar.js" init "$WT" > "$OUT/index.log"
node "$STELLAR_ROOT/bin/stellar.js" sync "$WT" --json >> "$OUT/index.log"
node "$STELLAR_ROOT/bin/stellar.js" benchmark run "$WT" --agent claude --mode "$MODES" --repeat "$REPEAT" \
  ${IDS:+--task-ids "$IDS"} --tasks "$TASKS" --repository "$REPO" --out "$OUT" 2>&1 | tee "$OUT/run.log"
echo "$OUT"
