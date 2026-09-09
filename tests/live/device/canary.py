#!/usr/bin/env python3
"""MEAL-7: the nightly canary, driven on the connected Pixel.

Runs the REAL shipped app -- the real WebView cart engine, the real automation
config, the real telemetry -- on home broadband, because that is the code path
users are actually on. Fixture tests go stale silently, and a green fixture suite
against a changed site reads as safety while being the opposite.

WHAT THIS FILE DOES AND DOES NOT DO
-----------------------------------
It drives the device and records WHEN it did so. It does not observe outcomes and
it does not score: observations come from the run's own telemetry (structured,
server-side, and already carrying MEAL-219's vocabulary) and scoring lives in
src/lib/canary-expectations.ts, which is pure and unit tested.

An earlier version of this file tried to parse outcomes out of the device log.
That does not work: the log names an item differently depending which line you
catch it on -- the ingredient in a search failure, the PRODUCT in the review
list -- so a plan written in ingredient names could never be matched against it.
The parsing was removed rather than left half-working.

PREFLIGHT IS NOT OPTIONAL
-------------------------
The device must be awake, unlocked, connected, running the app, and signed in to
the store. Any of those missing reports CANARY DID NOT RUN with a reason -- never
a store failure. An unplugged night that reads as a red store trains everyone to
ignore the colour, which costs more than the missed run.
"""
import json
import urllib.request, os, random, subprocess, sys, time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
import drive  # noqa: E402

PKG = 'co.mealio.app'


def sh(*a, t=30):
    return subprocess.run(a, capture_output=True, text=True, timeout=t).stdout


def now_iso():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


# ── Preflight ───────────────────────────────────────────────────────────────

def preflight():
    """Everything that must be true before a result means anything.

    Returns None when the rig is ready, or (reason, detail). The reasons match
    CanarySkipReason in canary-expectations.ts.
    """
    if not [l for l in sh('adb', 'devices').splitlines()[1:] if '\tdevice' in l]:
        return ('device_offline', 'adb lists no device in state "device"')

    power = sh('adb', 'shell', 'dumpsys', 'power')
    if 'mWakefulness=Asleep' in power or 'mWakefulness=Dozing' in power:
        return ('device_locked', 'screen is asleep')
    if 'mDreamingLockscreen=true' in sh('adb', 'shell', 'dumpsys', 'window'):
        return ('device_locked', 'lock screen is showing')

    if PKG not in sh('adb', 'shell', 'pm', 'list', 'packages'):
        return ('app_not_installed', f'{PKG} is not installed')
    return None


def signed_in(store_chip, timeout_s=90):
    """Ask the app whether it is signed in to this store, before running.

    Store sessions expire, and a canary that drives a run against a signed-out
    store measures the login screen. That is a RIG problem: the automation is
    fine and nobody has told it otherwise.

    The prewarm's verdict is trustworthy for this since 2026-09-07, when it
    started reading the store's own `guest` flag rather than inferring a session
    from a cart.
    """
    mark = drive.log_mark()
    chip = drive.find(store_chip, exact=True)
    if not chip:
        # The chip row is horizontally scrollable and shows about four at a time.
        for _ in range(6):
            drive.sh('adb', 'shell', 'input', 'swipe', '950', '280', '150', '280', '500')
            time.sleep(1.2)
            chip = drive.find(store_chip, exact=True)
            if chip:
                break
    if not chip:
        return (False, f'no store chip for {store_chip}')
    drive.tap(chip)
    # THREE ANSWERS, NOT ONE: probed, cached ("checkStore skip ... already
    # loggedOut"), or no rail at all (Kroger). The first version waited only for
    # a probe line and read a cached verdict as "never answered", which would
    # have reported a healthy signed-out store as a broken rig.
    line, _ = drive.log_wait(mark, r'probe .*(finishing|result)|checkStore skip', timeout_s)
    if not line:
        return (False, 'the prewarm never answered')
    if 'not a WebView store' in line:
        return (False, 'no WebView rail for this store (Kroger family)')
    if 'loggedIn= true' in line or ('loggedIn' in line and 'loggedOut' not in line):
        return (True, 'signed in')
    return (False, line.strip()[-90:])


# ── The run shapes ──────────────────────────────────────────────────────────

def _start_run(meal_name, second_meal=None):
    """Select the canary meal (and optionally a second) and start the run.

    BY NAME, not by position. This tapped "the first meal card" at a fixed
    coordinate, which was fine while one canary meal existed and wrong the moment
    there were five: My Meals is ordered by recency, so the first card is
    whichever store was curated last, and every store would have run the same
    store's meal. Each canary meal is therefore named for its store.
    """
    drive.tap_text(meal_name, timeout=40)
    time.sleep(1.5)
    if second_meal:
        # The combination run: two meals in one add, which exercises the merge
        # a single-meal run never reaches.
        drive.tap_text(second_meal, timeout=40)
        time.sleep(1.5)
    drive.tap_xy(539, 2100)                     # the floating action
    time.sleep(3)
    drive.tap_xy(539, 2113)                     # confirm on the qty sheet


def run_once(meal_name, shape='single', settle_s=240, second_meal=None):
    """Drive one run and return when it finalizes. Records the window."""
    since = now_iso()
    mark = drive.log_mark()
    _start_run(meal_name, second_meal=second_meal if shape == 'combination' else None)
    end = time.time() + settle_s
    while time.time() < end:
        lines = drive.log_since(mark)
        if any(('reconcile:' in l) or ('dead end' in l) or ('run complete' in l) for l in lines):
            break
        time.sleep(3)
    return since


def cart_count(timeout_s=60):
    """The cart's line count, read from the app's own CART_COUNT message.

    Used by the repeat run, which asserts the cart GROWS. Adds land on top
    (2026-09-01), so a second run doubling is correct and idempotency would be
    the regression.
    """
    for line in reversed(drive.log_since(0)):
        if 'CART_COUNT' in line and 'count' in line:
            try:
                seg = line[line.index('{'):]
                return json.loads(seg[:seg.index('}') + 1]).get('count')
            except Exception:
                continue
    return None


def added_ids(mark):
    """The store line ids this run put in the cart.

    The run already computes the before/after delta -- that is what colours the
    done screen's green rows -- and now says which store ids those rows are.
    Cleanup removes exactly those.
    """
    ids = []
    for line in drive.log_since(mark):
        if 'canary: added ids' in line:
            try:
                ids = json.loads(line[line.index('['):line.rindex(']') + 1])
            except Exception:
                continue
    return [str(i) for i in ids]


def load_plans():
    """Enabled rows from `canary_plans`, newest curation wins.

    Service-role, because this runs on the box rather than as a signed-in user
    and RLS would otherwise hide every row.
    """
    env = {}
    for line in open(os.path.expanduser('~/mealio_central/.env.local')):
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()
    url = env.get('NEXT_PUBLIC_SUPABASE_URL')
    key = env.get('SUPABASE_SERVICE_ROLE_KEY')
    if not url or not key:
        return []
    req = urllib.request.Request(
        url + '/rest/v1/canary_plans?select=*&enabled=eq.true',
        headers={'apikey': key, 'authorization': 'Bearer ' + key})
    with urllib.request.urlopen(req, timeout=30) as r:
        rows = json.loads(r.read().decode())
    return [{'storeId': row['store_id'],
             'storeChip': row.get('store_chip') or row['store_id'],
             'mealName': row.get('meal_name'),
             'outOfStock': row.get('out_of_stock_item') or '',
             'unmatched': row.get('unmatched_item') or ''}
            for row in rows if row.get('store_id')]


def cleanup(store_id, only=None):
    """Remove what this run added from the test cart.

    NOT "empty the cart". The canary runs against Stephen's real account, whose
    Wegmans cart was 18 lines and $237 when this was written; emptying it to tidy
    up after a test would delete real groceries. `only` is the list of store line
    ids the run added, and every rail's clearCart scopes to it.

    An EMPTY list means the run added nothing that carries an id, so there is
    nothing to clean up -- which is reported as such rather than falling through
    to the unscoped clear, because unscoped here means "the whole basket".

    A canary that leaves state behind poisons its own next run, so failing this
    is a CANARY failure -- it is just not evidence about the store's automation,
    which is why it is reported separately from the scored lines.

    NOT EVERY RAIL CAN. `clearCart` is optional on the rail interface and a rail
    whose removal semantics have not been measured does not define it: Instacart
    SETS a line so quantity 0 removes it, while Wegmans' endpoint adds a line and
    does nothing to an existing one, so the same call there would return 200,
    change nothing, and report success. Unsupported is reported as unsupported.
    """
    supported = subprocess.run(
        ['npx', 'tsx', '-e',
         "import {getNetworkRail} from './src/lib/webview-scripts/network-rail';"
         f" const r = getNetworkRail({store_id!r});"
         " console.log(r && typeof r.clearCart === 'function' ? 'yes' : 'no')"],
        capture_output=True, text=True, timeout=120,
        cwd=os.path.join(os.path.dirname(__file__), '..', '..', '..', 'mealio_app'),
    ).stdout.strip().splitlines()[-1:] or ['no']
    if supported[0] != 'yes':
        return (None, 'this rail has no measured way to empty a cart')

    if only is None or not len(only):
        # Deliberately NOT a fall-through to the unscoped clear. Nothing to
        # remove and "remove everything" must never be the same branch.
        return (None, 'the run added no line this rail gives an id for')

    # The script runs in the cart sheet's WebView, so the sheet has to be open on
    # this store. Driven the same way a run is: nothing here reaches past the UI.
    mark = drive.log_mark()
    drive.tap_xy(539, 2100)
    time.sleep(2)
    drive.tap_xy(539, 2113)
    line, _ = drive.log_wait(mark, r'CART_CLEARED', 90)
    if not line:
        return (False, 'no CART_CLEARED came back')
    return ('"ok": true' in line or "'ok': true" in line, line.strip()[-120:])


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    out = {'startedAt': now_iso(), 'results': []}

    problem = preflight()
    if problem:
        reason, detail = problem
        out.update({'ran': False, 'reason': reason, 'detail': detail})
        print(json.dumps(out, indent=2))
        # Exit 0: the canary not running is not a store failure, and a non-zero
        # exit would page someone about an unplugged phone.
        return 0

    out['ran'] = True
    # THE DB IS THE SOURCE, not a file on this box. The plans moved to
    # `canary_plans` when the admin panel gained the per-store boxes and the
    # ON/OFF toggle; a JSON file next to the runner would go stale the first time
    # Stephen curated a store, and the runner would then be testing something
    # nobody had asked for. The scorer reads the same table.
    plans = load_plans()
    if not plans:
        out.update({'ran': False, 'reason': 'no_plans',
                    'detail': 'canary_plans has no enabled rows'})
        print(json.dumps(out, indent=2))
        return 0

    for plan in [p for p in plans if p.get('storeId')]:
        store, chip = plan['storeId'], plan.get('storeChip', plan['storeId'])
        drive.restart_app()
        time.sleep(8)
        drive.tap_id('tab-mymeals', timeout=40)
        time.sleep(2)

        ok, why = signed_in(chip)
        if not ok:
            out['results'].append({'storeId': store, 'ran': False,
                                   'skipReason': 'not_signed_in', 'detail': why})
            continue

        entry = {'storeId': store, 'ran': True, 'windows': {}}
        run_mark = drive.log_mark()
        meal = plan.get('mealName') or 'Canary'
        entry['windows']['single'] = run_once(meal)
        before = cart_count()

        # The repeat run: same meals again, against a non-empty cart.
        entry['windows']['repeat'] = run_once(meal)
        entry['cart'] = {'before': before, 'after': cart_count()}

        # The combination run: two meals at once.
        # The second meal is any OTHER meal saved for this store; without one the
        # combination window is skipped rather than faked.
        entry['windows']['combination'] = (
            run_once(meal, 'combination', second_meal=plan.get('secondMeal'))
            if plan.get('secondMeal') else None)

        # Collected across ALL THREE windows: the repeat and the combination add
        # on top (2026-09-01), so each contributes lines the cleanup owns.
        entry['addedIds'] = sorted(set(added_ids(run_mark)))

        cleaned, detail = cleanup(store, only=entry.get('addedIds') or [])
        entry['cleanup'] = {'ok': cleaned, 'detail': detail}
        out['results'].append(entry)

        # STAGGERED AND JITTERED between stores. Originally a WAF mitigation and
        # still worth it; now it is also just one device serialising many stores.
        time.sleep(30 + random.randint(0, 60))

    print(json.dumps(out, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
