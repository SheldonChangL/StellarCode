#!/bin/sh
# v0.5.6 holdout campaign: one repository x one agent, repeat=3, mode=both.
# Usage: run-campaign.sh <repo> <agent> [repeat] [limit]
set -eu
REPO="$1"; AGENT="$2"; REPEAT="${3:-3}"; LIMIT="${4:-0}"
STELLAR_ROOT=/Users/sheldon.chang/Projects/Private/StellarCode_M0-M3_Complete
HOLDOUT=/Users/sheldon.chang/Projects/Private/stellar-holdout-v056
WT="$HOLDOUT/$REPO"
TASKS="$STELLAR_ROOT/validation/v0.5.6/$REPO/tasks.json"
STAMP=$(date +%Y%m%d-%H%M%S)
KIND=$([ "$LIMIT" = "0" ] && echo holdout || echo smoke)
OUT="$STELLAR_ROOT/validation/v0.5.6/$KIND/$REPO/$AGENT-$STAMP"
export STELLAR_DATA_DIR="$HOLDOUT/data/$REPO-$AGENT-$STAMP"
export STELLAR_CACHE_DIR="$HOLDOUT/cache/$REPO-$AGENT-$STAMP"
export STELLAR_LOG_DIR="$HOLDOUT/logs/$REPO-$AGENT-$STAMP"

# Task set must be frozen and unchanged.
(cd "$STELLAR_ROOT/validation/v0.5.6/$REPO" && shasum -a 256 -c TASKSET.sha256)
# Holdout worktree must be clean at its fixed commit (.stellar/ metadata excepted).
test -z "$(git -C "$WT" status --porcelain | grep -v '^?? .stellar/$' || true)"
# Runtime must be committed (no uncommitted runtime source).
test -z "$(git -C "$STELLAR_ROOT" status --porcelain -- src bin package.json)"

mkdir -p "$OUT"
{
  echo "repo=$REPO agent=$AGENT repeat=$REPEAT limit=$LIMIT"
  echo "repoCommit=$(git -C "$WT" rev-parse HEAD)"
  echo "stellarCommit=$(git -C "$STELLAR_ROOT" rev-parse HEAD)"
  echo "dataDir=$STELLAR_DATA_DIR"
} > "$OUT/campaign.env"

# Fresh index of the clean commit in a private data dir.
node "$STELLAR_ROOT/bin/stellar.js" init "$WT" > "$OUT/index.log"
node "$STELLAR_ROOT/bin/stellar.js" sync "$WT" --json >> "$OUT/index.log"

node "$STELLAR_ROOT/bin/stellar.js" benchmark run "$WT" --agent "$AGENT" --mode both --repeat "$REPEAT" \
  --limit "$LIMIT" --tasks "$TASKS" --repository "$REPO" --out "$OUT" 2>&1 | tee "$OUT/run.log"
echo "$OUT"
