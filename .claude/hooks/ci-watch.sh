#!/usr/bin/env bash
# PostToolUse(Bash) asyncRewake hook: after a `git push`, wait for the
# GitHub Actions runs on the pushed commit to finish, then exit 2 so the
# harness wakes Claude with the check results.
#
# Exit codes:
#   0 — nothing to do (not a push, no runs appeared, or gh unavailable)
#   2 — checks finished; stdout carries the summary Claude wakes up to

set -u

# gh and jq may live in ~/bin on this machine (installed without sudo).
export PATH="$HOME/bin:$PATH"

# gh may live in ~/bin on this machine.
GH="$(command -v gh || true)"
[ -z "$GH" ] && [ -x "$HOME/bin/gh" ] && GH="$HOME/bin/gh"
[ -z "$GH" ] && exit 0

INPUT="$(cat)"
CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"

# Only act on actual pushes (covers compound commands like `git add && git push`).
case "$CMD" in
  *"git push"*) ;;
  *) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" || exit 0
SHA="$(git rev-parse HEAD 2>/dev/null)" || exit 0

# Give GitHub a moment to register the workflow runs.
RUNS=""
for _ in 1 2 3 4 5 6; do
  sleep 20
  RUNS="$("$GH" run list --commit "$SHA" --json databaseId,status,conclusion,name 2>/dev/null)"
  [ -n "$RUNS" ] && [ "$(printf '%s' "$RUNS" | jq 'length')" -gt 0 ] && break
done
if [ -z "$RUNS" ] || [ "$(printf '%s' "$RUNS" | jq 'length')" -eq 0 ]; then
  # No workflows triggered by this push (e.g. docs-only path filter). Stay silent.
  exit 0
fi

# Poll until every run on this commit completes. Bound: ~50 minutes
# (the iOS job can take 30+; pad for queue time).
for _ in $(seq 1 100); do
  RUNS="$("$GH" run list --commit "$SHA" --json databaseId,status,conclusion,name 2>/dev/null)"
  PENDING="$(printf '%s' "$RUNS" | jq '[.[] | select(.status != "completed")] | length')"
  [ "$PENDING" = "0" ] && break
  sleep 30
done

SUMMARY="$(printf '%s' "$RUNS" | jq -r '.[] | "\(.name): \(.conclusion // .status)"')"
FAILED="$(printf '%s' "$RUNS" | jq '[.[] | select(.conclusion != null and .conclusion != "success" and .conclusion != "skipped")] | length')"

echo "GitHub Actions finished for commit ${SHA:0:8}:"
echo "$SUMMARY"
if [ "$FAILED" = "0" ]; then
  echo "ALL GREEN. Per the standing workflow: report statuses to Stephen, then run 'eas build --platform ios --profile production --clear-cache', and when that finishes remind him to optionally run 'eas submit --platform ios'."
else
  echo "$FAILED run(s) failed. Read the logs via 'gh run view <id> --log-failed', fix, and push again."
fi
exit 2
