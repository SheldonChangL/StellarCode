#!/bin/sh
# v0.8.5 two-turn campaign: one repository, baseline / hook-nohints / hook, each run resumed
# once with the task's follow-up.
# Usage: MODEL=<id> run.sh <repo> <stage> [task-ids]
set -eu
REPO="$1"; STAGE="$2"; IDS="${3:-}"; MODES="${MODES:-baseline,hook-nohints,hook}"
: "${MODEL:?MODEL must be set: the CLI default model can change between campaigns}"
STELLAR_ROOT=/Users/sheldon.chang/Projects/Private/StellarCode_M0-M3_Complete
HOLDOUT=/Users/sheldon.chang/Projects/Private/stellar-holdout-v07
WT="$HOLDOUT/$REPO"
TASKS="$STELLAR_ROOT/validation/followup/tasksets/$REPO/tasks.json"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$STELLAR_ROOT/validation/followup/$STAGE/$REPO/claude-$STAMP"
export STELLAR_DATA_DIR="$HOLDOUT/data/followup-$REPO-$STAMP"
export STELLAR_CACHE_DIR="$HOLDOUT/cache/followup-$REPO-$STAMP"
export STELLAR_LOG_DIR="$HOLDOUT/logs/followup-$REPO-$STAMP"
(cd "$(dirname "$TASKS")" && shasum -a 256 -c TASKSET.sha256)
test -z "$(git -C "$WT" status --porcelain | grep -v '^?? .stellar/$' || true)"
test -z "$(git -C "$STELLAR_ROOT" status --porcelain -- src bin package.json)"
mkdir -p "$OUT"
{
  echo "repo=$REPO stage=$STAGE taskIds=$IDS modes=$MODES"
  echo "repoCommit=$(git -C "$WT" rev-parse HEAD)"
  echo "stellarCommit=$(git -C "$STELLAR_ROOT" rev-parse HEAD)"
  echo "model=$MODEL"
} > "$OUT/campaign.env"
node "$STELLAR_ROOT/bin/stellar.js" init "$WT" > "$OUT/index.log"
node "$STELLAR_ROOT/bin/stellar.js" sync "$WT" --json >> "$OUT/index.log"
node "$STELLAR_ROOT/bin/stellar.js" benchmark run "$WT" --agent claude --mode "$MODES" --follow-up \
  --model "$MODEL" ${IDS:+--task-ids "$IDS"} --tasks "$TASKS" --repository "$REPO" --out "$OUT" 2>&1 | tee "$OUT/run.log"
echo "$OUT"
