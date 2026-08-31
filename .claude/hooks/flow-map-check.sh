#!/usr/bin/env bash
# PreToolUse(Bash) hook: before a `git push`, ask whether any flow map in
# docs/flow-maps/ describes source that has moved since the map was written.
#
# Docs go stale silently — that is the whole problem this guards. The push is
# the right moment because it is when the change becomes everyone else's, and
# because updating a map belongs in the same push as the code that changed it.
#
# Exit codes:
#   0 — not a push, no manifest on this branch, or every map is current
#   2 — at least one map's sources moved; stderr goes back to Claude and the
#       push is blocked until the maps are looked at
#
# Escape hatch: MEALIO_SKIP_FLOWMAP_CHECK=1 in the pushing command.

set -u

INPUT="$(cat)"
CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"

# Only act on actual pushes (covers compound commands like `git add && git push`).
case "$CMD" in
  *"git push"*) ;;
  *) exit 0 ;;
esac

# A deliberate override, written into the command itself so it is visible in the
# transcript rather than hidden in an environment nobody can see.
case "$CMD" in
  *MEALIO_SKIP_FLOWMAP_CHECK=1*) exit 0 ;;
esac

# Where the push actually happens, not where the session started — pushes come
# from git worktrees, and resolving in CLAUDE_PROJECT_DIR would check whatever
# `main` is sitting at instead of the branch being pushed. Same recovery as
# ci-watch.sh: prefer the payload's cwd, else the `cd` the command carries.
HOOK_CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)"
if [ -z "$HOOK_CWD" ]; then
  CD_PATH="$(printf '%s' "$CMD" | sed -n 's/^[[:space:]]*cd[[:space:]]\{1,\}\([^&|;]*\).*/\1/p' | head -1 | sed 's/[[:space:]]*$//')"
  [ -n "$CD_PATH" ] && [ -d "$CD_PATH" ] && HOOK_CWD="$CD_PATH"
fi
cd "${HOOK_CWD:-${CLAUDE_PROJECT_DIR:-$(pwd)}}" || exit 0

# The repo ROOT of whatever checkout we landed in — the scripts and the manifest
# live there, and a push issued from a subdirectory is still a push.
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
CHECK="$ROOT/scripts/check-flow-maps.js"

# A branch cut before the maps existed has neither the script nor the manifest.
# That is not a failure — there is simply nothing to check.
[ -f "$CHECK" ] || exit 0
[ -f "$ROOT/docs/flow-maps/sources.json" ] || exit 0

NODE="$(command -v node || true)"
[ -z "$NODE" ] && exit 0

OUT="$("$NODE" "$CHECK" --quiet 2>&1)"
STATUS=$?
[ "$STATUS" -eq 0 ] && exit 0

# Exit 2 sends stderr back to Claude and blocks the push.
{
  printf '%s\n' "$OUT"
  printf '%s\n' "Update the maps that actually moved, run \`npm run flow-maps:bless\`,"
  printf '%s\n' "and include both in this push. If none of these changes touch what the"
  printf '%s\n' "maps describe, bless them anyway — that records that someone looked."
  printf '%s\n' "To push without checking: prefix the command with MEALIO_SKIP_FLOWMAP_CHECK=1."
} >&2
exit 2
