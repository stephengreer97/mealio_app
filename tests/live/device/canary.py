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
import re
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


def select_store(store_chip):
    """Tap a store's chip, scrolling the chip row to reach it.

    My Meals is FILTERED by the selected chip, so this is not only how the
    prewarm is asked about a store -- it is how the store's canary meal becomes
    visible at all. Choosing products for "Canary ALDI" while Wegmans was
    selected simply scrolled a list that could never contain it.
    """
    chip = drive.find(store_chip, exact=True)
    if not chip:
        # The chip row is horizontally scrollable and shows about four at a time.
        for _ in range(8):
            drive.sh('adb', 'shell', 'input', 'swipe', '950', '280', '150', '280', '500')
            time.sleep(1.2)
            chip = drive.find(store_chip, exact=True)
            if chip:
                break
    if not chip:
        return False
    drive.tap(chip)
    time.sleep(2)
    return True


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
    if not select_store(store_chip):
        return (False, f'no store chip for {store_chip}')
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

def _start_run(meal_name, second_meal=None, store_chip=None):
    """Select the canary meal (and optionally a second) and start the run.

    BY NAME, not by position. This tapped "the first meal card" at a fixed
    coordinate, which was fine while one canary meal existed and wrong the moment
    there were five: My Meals is ordered by recency, so the first card is
    whichever store was curated last, and every store would have run the same
    store's meal. Each canary meal is therefore named for its store.
    """
    # BACK TO MY MEALS FIRST. A window leaves the app on the run's done screen,
    # which is a sheet OVER the tab bar -- so the next window could not even
    # reach the tab, let alone a meal card. Dismiss whatever is on top, then
    # navigate. The tab is idempotent: tapping it from My Meals is a no-op.
    _dismiss_overlay()
    drive.tap_id('tab-mymeals', timeout=40)
    time.sleep(2)
    if store_chip:
        select_store(store_chip)
    drive.scroll_to(meal_name)
    drive.tap_text(meal_name, timeout=40)
    time.sleep(1.5)
    if second_meal:
        # The combination run: two meals in one add, which exercises the merge
        # a single-meal run never reaches.
        drive.tap_text(second_meal, timeout=40)
        time.sleep(1.5)
    # BY ID, not by coordinate. These two taps were the last blind ones, and they
    # are why a "successful" run finished in 22 seconds having done nothing: a
    # coordinate that misses is silent, and the window then broke out of its wait
    # on a reconcile line left over from an earlier run.
    drive.tap_id('floating-add-to-cart', timeout=40)
    time.sleep(4)
    # The confirm sheet. With products already chosen the primary reads "Add to
    # cart"; it is the same id the chooser's primary uses.
    if drive.find_id('review-primary'):
        drive.tap_id('review-primary', timeout=20)


def _dismiss_overlay(tries=3):
    """Close a run's done sheet (or any modal) so the tabs are reachable again.

    Tried in order of how a person would leave: the explicit Done, then the
    close glyph, then the hardware back. Silent when there is nothing to close,
    because the common case is that the screen is already fine.
    """
    for _ in range(tries):
        if drive.find_id('tab-mymeals'):
            return True
        for label in ('Done', '\u2715'):
            node = drive.find(label, exact=True)
            if node:
                drive.tap(node)
                time.sleep(2)
                break
        else:
            drive.sh('adb', 'shell', 'input', 'keyevent', 'KEYCODE_BACK')
            time.sleep(2)
    return bool(drive.find_id('tab-mymeals'))


def _chooser_step(xml):
    """The chooser's own progress label, e.g. "Choose Product (2 of 3)"."""
    m = re.search(r'Choose Product \(\d+ of \d+\)', xml or '')
    return m.group(0) if m else None


def choose_products(meal_name, store_chip, max_steps=12):
    """Walk the product chooser once for a canary meal.

    A meal added from the app cannot be run until its products are chosen: the
    card says "Choose products once to add to cart" and the floating action reads
    "Choose Products", not "Add to cart". Every canary window before this existed
    tapped that button, landed in the chooser, and finalised nothing -- which is
    why the first green-looking run reported no reconcile, no added ids, and a
    cart that went from 0 to 0.

    First candidate, always. The canary is not testing whether the ranking picks
    a good product; it is testing that the add, the reconcile and the cleanup
    work. An ingredient with no candidates at all -- "Nonexistent unobtainium
    9000" is in every canary meal for exactly this -- is skipped, which is the
    branch it is there to exercise.
    """
    drive.tap_id('tab-mymeals', timeout=40)
    time.sleep(2)
    select_store(store_chip)
    # SCROLL FIRST. My Meals is a long list ordered by recency and tap_id does
    # not scroll; a canary meal several rows down is simply not there yet.
    drive.scroll_to(meal_name)
    drive.tap_id('meal-card-' + meal_name, timeout=40)
    time.sleep(1.5)
    drive.tap_id('floating-add-to-cart', timeout=40)
    time.sleep(6)

    # NEVER CHOOSE A PRODUCT FOR THESE. The line exists to be unfindable, and
    # a store will happily suggest SOMETHING for it -- ALDI offered allergy
    # tablets, a sauvignon blanc and a dog basket. Picking the first of those
    # turns the branch it is there to test into an ordinary add.
    never = ['Nonexistent unobtainium 9000']

    steps = []
    for _ in range(max_steps):
        xml = drive.ui()
        if any(n in xml for n in never) and drive.find('Skip this ingredient'):
            drive.tap_text('Skip this ingredient', timeout=20)
            time.sleep(3)
            steps.append('left-unfindable')
            continue
        if 'floating-add-to-cart' in xml and 'candidate-' not in xml:
            break                                   # back on My Meals: done
        if 'candidate-0' in xml:
            # THREE TAPS, AND THE MIDDLE ONE IS NOT OPTIONAL. Selecting a
            # product does not enable the primary: the quantity has to be set
            # first, which is the small qty section at the bottom of the sheet
            # (the one MEAL-218 put a glow on because it gets glanced over).
            # Without the '+' the primary is disabled, the screen does not move,
            # and the loop spins on the same ingredient until it runs out of
            # steps -- which is exactly what happened the first time.
            #
            # candidate-0 by ID, not by its text: tapping the row's label selects
            # nothing.
            where = _chooser_step(xml)
            drive.tap_id('candidate-0', timeout=20)
            time.sleep(2)
            try:
                drive.tap_text('+', timeout=10)
                time.sleep(1.5)
            except Exception:
                pass
            drive.tap_id('review-primary', timeout=20)
            time.sleep(3)
            # DID IT ACTUALLY MOVE? The primary is disabled until the quantity is
            # set, and a disabled tap is silent -- so without this the loop spins
            # on one ingredient until max_steps and reports twelve cheerful
            # "chose" steps having chosen nothing. H-E-B did exactly that.
            if _chooser_step(drive.ui()) == where:
                drive.tap_id('candidate-0', timeout=20)
                time.sleep(1.5)
                try:
                    drive.tap_text('+', timeout=10)
                    time.sleep(1.5)
                except Exception:
                    pass
                drive.tap_id('review-primary', timeout=20)
                time.sleep(3)
                if _chooser_step(drive.ui()) == where:
                    # Leave it rather than fight it: an unchosen line is honest,
                    # and the run reports it as skipped.
                    if drive.find('Skip this ingredient'):
                        drive.tap_text('Skip this ingredient', timeout=20)
                        time.sleep(3)
                    steps.append('stuck')
                    continue
            steps.append('chose')
            continue
        if drive.find('Skip this ingredient'):
            drive.tap_text('Skip this ingredient', timeout=20)
            time.sleep(3)
            steps.append('skipped')
            continue
        if drive.find('Done'):
            drive.tap_text('Done', timeout=20)
            time.sleep(3)
            steps.append('done')
            break
        break
    return steps


def run_once(meal_name, shape='single', settle_s=240, second_meal=None, store_chip=None):
    """Drive one run and return when it finalizes. Records the window."""
    since = now_iso()
    # MARKED BEFORE THE NAVIGATION, so the wait below cannot be satisfied by a
    # reconcile line from the PREVIOUS window.
    mark = drive.log_mark()
    _start_run(meal_name, second_meal=second_meal if shape == 'combination' else None,
               store_chip=store_chip)
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
    # REGEX, not a JSON slice. The plain form of this line carries no braces at
    # all ("CART_COUNT phase= reconcile count= 58"), and the JSON form's first
    # closing brace belongs to the first cart ITEM, so slicing to it produced
    # invalid JSON. Both were swallowed by the except, and the cart read as 0.
    for line in reversed(drive.log_since(0)):
        if 'CART_COUNT' not in line:
            continue
        m = re.search(r'\bcount[=:]\s*"?(\d+)', line)
        if m:
            return int(m.group(1))
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
            # FROM AFTER THE MARKER. The log's own prefix is "[Cart 20:14:34]",
            # so indexing to the first '[' in the line grabbed the timestamp and
            # parsed nothing -- silently, into an empty list.
            tail = line.split('canary: added ids', 1)[1]
            try:
                ids = json.loads(tail[tail.index('['):tail.rindex(']') + 1])
            except Exception:
                continue
    return [str(i) for i in ids]


def store_chips():
    """storeId -> the name the app puts on the chip, read from its own constant.

    Parsed rather than duplicated: a second copy of this mapping would go stale
    the first time a store was renamed, and the failure would look like "not
    signed in" rather than like a typo.
    """
    src = os.path.join(os.path.dirname(__file__), '..', '..', '..',
                       'src', 'constants', 'stores.ts')
    out = {}
    for m in re.finditer(r"\{\s*id:\s*'([^']+)'\s*,\s*name:\s*('[^']*'|\"[^\"]*\")", open(src).read()):
        out[m.group(1)] = m.group(2)[1:-1]
    return out


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
    chips = store_chips()
    return [{'storeId': row['store_id'],
             # THE CHIP IS THE DISPLAY NAME. The plan table stores a store_id
             # ('aldi'), and the chip row shows what the app calls it ('ALDI'),
             # so falling back to the id found no chip and reported every store
             # as not signed in -- a rig problem, and a made-up one.
             'storeChip': chips.get(row['store_id'], row['store_id']),
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
        cwd=os.path.join(os.path.dirname(__file__), '..', '..', '..'),
    ).stdout.strip().splitlines()[-1:] or ['no']
    if supported[0] != 'yes':
        return (None, 'this rail has no measured way to empty a cart')

    if only is None or not len(only):
        # Deliberately NOT a fall-through to the unscoped clear. Nothing to
        # remove and "remove everything" must never be the same branch.
        return (None, 'the run added no line this rail gives an id for')

    # The ids themselves travel through the APP, not through this call: a tap
    # carries no arguments, so the run wrote them down and the probe reads them
    # back. What `only` does here is decide whether cleanup is worth driving.

    # The script runs in the cart sheet's WebView, so the sheet has to be open on
    # this store. Driven the same way a run is: nothing here reaches past the UI.
    # THROUGH ACCOUNT, not through the meal flow. Driving the cart sheet meant
    # selecting a meal and tapping the add action, which would have added a
    # FOURTH time before cleaning up. The dev control opens a hidden WebView on
    # the store and clears from there, touching nothing else.
    base = drive.log_mark()
    _dismiss_overlay()
    # The tab by id, then by label: tapping the id alone did not always leave My
    # Meals, and a cleanup that silently stays put reads as a missing control.
    drive.tap_id('tab-account', timeout=40)
    time.sleep(2)
    if not drive.find('Clear canary items'):
        try:
            drive.tap_text('Account', timeout=20)
            time.sleep(2)
        except Exception:
            pass
    drive.scroll_to('Clear canary items')
    drive.tap_id('clear-cart-' + store_id, timeout=40)
    line, _ = drive.log_wait(base, r'CART_CLEARED|CartClear', 120)
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
    # `--store heb` runs one. The nightly job passes nothing and runs them all;
    # this is for proving a change against a single store without spending an
    # hour of device time to find out the runner has a typo in it.
    wanted = None
    for i, a in enumerate(sys.argv):
        if a == '--store' and i + 1 < len(sys.argv):
            wanted = sys.argv[i + 1]
    if wanted:
        plans = [p for p in plans if p.get('storeId') == wanted]
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
        entry['windows']['single'] = run_once(meal, store_chip=chip)
        before = cart_count()

        # The repeat run: same meals again, against a non-empty cart.
        entry['windows']['repeat'] = run_once(meal, store_chip=chip)
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
