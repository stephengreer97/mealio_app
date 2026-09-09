#!/usr/bin/env bash
# MEAL-7. The nightly canary: drive every enabled store on the Pixel, score each
# window against its plan, and publish the result where the admin panel reads it.
#
# WHY A WRAPPER AND NOT A CRON LINE. Three things have to happen in order and the
# middle one can fail per store without the others being wrong: driving is device
# work, scoring is a DB read, publishing is a DB write. A single cron line would
# either lose the runner's JSON or swallow a scorer exit code.
#
# EXIT CODE IS ALWAYS 0. A canary that could not run is not a failing store --
# the device may be asleep, unplugged or signed out -- and a non-zero exit here
# would page someone about a phone on a nightstand. Failures are published as
# rows, which is where they belong; the panel renders "did not run" grey and
# "failed" red, and the difference is the whole point.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 0
OUT_DIR="${HOME}/.mealio-canary"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RAW="$OUT_DIR/run-$STAMP.json"

# The runner prints one JSON document and nothing else on success. Its stderr is
# kept beside it, because "the device was locked" is the most common answer and
# it belongs in the file rather than in a mail spool.
python3 tests/live/device/canary.py > "$RAW" 2> "$OUT_DIR/run-$STAMP.err"

if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$RAW" 2>/dev/null; then
  echo "canary: runner produced no usable JSON; see $OUT_DIR/run-$STAMP.err" >&2
  exit 0
fi

# One store at a time: a store that could not be scored must not stop the rest
# from being published.
node -e '
const fs = require("fs");
const out = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (out.ran === false) {
  // The whole run did not happen -- device asleep, no enabled plans. One grey
  // row per enabled store would be noise; the absence IS the signal.
  console.log("canary: did not run:", out.reason || "unknown", out.detail || "");
  process.exit(0);
}
for (const r of out.results || []) {
  console.log(JSON.stringify({
    storeId: r.storeId,
    ran: r.ran !== false,
    skipReason: r.skipReason || null,
    windows: r.windows || {},
    cart: r.cart || null,
    cleanup: r.cleanup || null,
  }));
}
' "$RAW" | while read -r line; do
  STORE="$(node -e 'console.log(JSON.parse(process.argv[1]).storeId)' "$line")"
  SINCE="$(node -e 'const w=JSON.parse(process.argv[1]).windows||{}; console.log(w.single||"")' "$line")"
  RAN="$(node -e 'console.log(JSON.parse(process.argv[1]).ran)' "$line")"

  if [ "$RAN" != "true" ] || [ -z "$SINCE" ]; then
    node scripts/canary-publish.mjs "$line" || true
    continue
  fi

  # The scorer decides pass/fail; its exit code is the verdict, and 2 means the
  # run could not be found at all, which is a rig problem rather than a failure.
  SCORE="$(node scripts/canary-score.mjs "$STORE" "$SINCE" 2>&1)"
  CODE=$?
  node scripts/canary-publish.mjs "$(node -e '
    const base = JSON.parse(process.argv[1]);
    const code = Number(process.argv[3]);
    console.log(JSON.stringify({
      ...base,
      ran: code !== 2,
      skipReason: code === 2 ? "run_not_found" : base.skipReason,
      passed: code === 0,
      shape: "nightly",
      detail: process.argv[2].slice(0, 4000),
    }));
  ' "$line" "$SCORE" "$CODE")" || true
done

exit 0
