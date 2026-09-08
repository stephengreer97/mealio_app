#!/usr/bin/env python3
"""MEAL-7: the nightly canary, driven on the connected Pixel.

Runs the REAL shipped app -- the real WebView cart engine, the real automation
config, the real telemetry -- on home broadband, because that is the code path
users are actually on. Fixture tests go stale silently and a green fixture suite
against a changed site reads as safety while being the opposite.

WHAT THIS FILE DOES AND DOES NOT DO
-----------------------------------
It drives the device and OBSERVES. It does not decide whether a run passed:
scoring belongs to src/lib/canary-expectations.ts, which is pure, unit tested,
and shared with anything else that wants to read a canary. This file emits
observations as JSON and a scorer turns them into a verdict.

That split is deliberate. A runner that scores its own results is a runner whose
scoring can only be tested by running it against a live store.

PREFLIGHT IS NOT OPTIONAL
-------------------------
The device must be awake, unlocked, connected, running the app, and signed in per
store. Any of those missing reports CANARY DID NOT RUN with a reason -- never a
store failure. An unplugged night that reads as a red store trains everyone to
ignore the colour, which costs more than the missed run.
"""
import json, os, subprocess, sys, time

sys.path.insert(0, os.path.dirname(__file__))
import drive  # noqa: E402

PKG = 'co.mealio.app'


def sh(*a, t=30):
    return subprocess.run(a, capture_output=True, text=True, timeout=t).stdout


def preflight():
    """Everything that must be true before a result means anything.

    Returns None when the rig is ready, or a (reason, detail) pair naming what
    is wrong. The reasons match CanarySkipReason in canary-expectations.ts.
    """
    devices = [l for l in sh('adb', 'devices').splitlines()[1:] if '\tdevice' in l]
    if not devices:
        return ('device_offline', 'adb lists no device in state "device"')

    # Locked or asleep: a tap on a lock screen is not a canary run.
    power = sh('adb', 'shell', 'dumpsys', 'power')
    if 'mWakefulness=Asleep' in power or 'mWakefulness=Dozing' in power:
        return ('device_locked', 'screen is asleep')
    win = sh('adb', 'shell', 'dumpsys', 'window')
    if 'mDreamingLockscreen=true' in win:
        return ('device_locked', 'lock screen is showing')

    if PKG not in sh('adb', 'shell', 'pm', 'list', 'packages'):
        return ('app_not_installed', f'{PKG} is not installed')

    return None


def signed_in(store_chip, timeout_s=90):
    """Ask the app whether it is signed in to this store, before running.

    Store sessions expire, and a canary that drives a run against a signed-out
    store measures the login screen. It is a RIG problem, not a store failure --
    the automation is fine and nobody has told it otherwise.

    The prewarm's verdict is trustworthy for this now: since 2026-09-07 it reads
    the store's own `guest` flag rather than inferring a session from a cart, so
    "signed in" means signed in rather than "has a basket".
    """
    mark = drive.log_mark()
    chip = drive.find(store_chip, exact=True)
    if not chip:
        return (False, f'no store chip for {store_chip}')
    drive.tap(chip)
    # THREE ANSWERS, NOT ONE. The prewarm probes, OR reports a cached verdict
    # ("checkStore skip aldi - already loggedOut"), OR declines because the store
    # has no WebView rail at all (Kroger). The first version of this waited for a
    # probe line and read the cached answer as "never answered", which would have
    # reported a perfectly healthy signed-out store as a broken rig.
    line, _ = drive.log_wait(
        mark, r'probe .*(finishing|result)|checkStore skip', timeout_s)
    if not line:
        return (False, 'the prewarm never answered')
    if 'not a WebView store' in line:
        return (False, 'no WebView rail for this store (Kroger family)')
    if 'loggedIn= true' in line or 'loggedIn' in line and 'loggedOut' not in line:
        return (True, 'signed in')
    return (False, line.strip()[-90:])


def observe_run(store_id, meal_name, timeout_s=240):
    """Drive one store's canary meal and read what happened to each line.

    Reads the app's own log rather than the screen. The screen shows a summary;
    the log names every item and the reason it ended where it did, which is what
    an expectation table needs.
    """
    mark = drive.log_mark()
    obs, notes = [], []

    # The run is driven by the same steps a person takes, because a harness that
    # calls a function directly proves nothing about reachability.
    drive.tap_id('tab-mymeals', timeout=30)
    time.sleep(2)
    chip = drive.find(store_id, exact=True)
    if not chip:
        for _ in range(6):
            drive.sh('adb', 'shell', 'input', 'swipe', '950', '280', '150', '280', '500')
            time.sleep(1.2)
            chip = drive.find(store_id, exact=True)
            if chip:
                break
    if not chip:
        return None, [('not_signed_in', f'no store chip for {store_id}')]
    drive.tap(chip)
    time.sleep(2.5)

    drive.tap_xy(275, 600)          # select the meal card
    time.sleep(2)
    drive.tap_xy(539, 2100)         # the floating action
    time.sleep(3)
    drive.tap_xy(539, 2113)         # confirm on the qty sheet

    end = time.time() + timeout_s
    while time.time() < end:
        lines = drive.log_since(mark)
        if any('run complete' in l or 'reconcile:' in l or 'dead end' in l for l in lines):
            break
        time.sleep(3)

    for line in drive.log_since(mark):
        # cart verdicts and reconcile rows name the per-item outcome.
        if 'reconcile:' in line:
            notes.append(line.strip()[:400])
    return obs, notes


def main():
    out = {'startedAt': time.strftime('%Y-%m-%dT%H:%M:%S'), 'results': []}
    problem = preflight()
    if problem:
        reason, detail = problem
        out['ran'] = False
        out['reason'] = reason
        out['detail'] = detail
        print(json.dumps(out, indent=2))
        # Exit 0: the canary not running is not a store failure, and a non-zero
        # exit here would page someone about an unplugged phone.
        return 0

    out['ran'] = True
    plan_path = os.path.join(os.path.dirname(__file__), 'canary-plans.json')
    plans = json.load(open(plan_path)) if os.path.exists(plan_path) else []
    for plan in plans:
        obs, notes = observe_run(plan['storeChip'], plan['mealName'])
        out['results'].append({
            'storeId': plan['storeId'],
            'observations': obs or [],
            'notes': notes,
        })
    print(json.dumps(out, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
