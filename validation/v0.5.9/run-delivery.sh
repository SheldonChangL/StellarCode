#!/bin/sh
# v0.5.9 delivery experiment: one repository, delivery conditions, Latin-square order.
# Usage: run-delivery.sh <repo> <stage1|stage2|smoke> <modes> <repeat> [task-ids]
set -eu
REPO="$1"; STAGE="$2"; MODES="$3"; REPEAT="$4"; IDS="${5:-}"
STELLAR_ROOT=/Users/sheldon.chang/Projects/Private/StellarCode_M0-M3_Complete
HOLDOUT=/Users/sheldon.chang/Projects/Private/stellar-holdout-v058
WT="$HOLDOUT/$REPO"
TASKS="$STELLAR_ROOT/validation/v0.5.9/tasksets/$REPO/tasks.json"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$STELLAR_ROOT/validation/v0.5.9/$STAGE/$REPO/claude-$STAMP"
export STELLAR_DATA_DIR="$HOLDOUT/data/v059-$REPO-$STAMP"
export STELLAR_CACHE_DIR="$HOLDOUT/cache/v059-$REPO-$STAMP"
export STELLAR_LOG_DIR="$HOLDOUT/logs/v059-$REPO-$STAMP"

# Frozen task set unchanged, clean worktree at its fixed commit, runtime committed.
(cd "$STELLAR_ROOT/validation/v0.5.9/tasksets/$REPO" && shasum -a 256 -c TASKSET.sha256)
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
