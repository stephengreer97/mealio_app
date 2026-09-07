#!/usr/bin/env python3
"""Drive the Pixel over adb: dump the UI, find a node, tap it, read the logs.

Deliberately small. Everything here is observation plus taps -- it knows nothing
about what a scenario means, so a scenario script reads as the steps a person
would take, and a failure points at the step rather than at the plumbing.
"""
import re, subprocess, sys, time, os

PKG = 'co.mealio.app'

def sh(*a, **kw):
    return subprocess.run(a, capture_output=True, text=True, timeout=kw.get('t', 60)).stdout

def ui():
    """The current view hierarchy as XML. Retried: uiautomator loses races with
    an animating React Native surface and returns an empty or partial dump."""
    for _ in range(4):
        out = sh('adb', 'exec-out', 'uiautomator', 'dump', '/dev/tty')
        if '<node' in out:
            return out
        time.sleep(0.6)
    return ''

def nodes(xml):
    for m in re.finditer(r'<node[^>]*>', xml):
        tag = m.group(0)
        g = lambda k: (re.search(k + r'="([^"]*)"', tag) or [None, ''])[1]
        b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', tag)
        if not b:
            continue
        x1, y1, x2, y2 = map(int, b.groups())
        yield {'text': g('text'), 'desc': g('content-desc'), 'id': g('resource-id'),
               'cx': (x1 + x2) // 2, 'cy': (y1 + y2) // 2, 'w': x2 - x1, 'h': y2 - y1}

def find(needle, xml=None, exact=False):
    """First visible node whose text or description matches. Zero-sized nodes are
    skipped: React Native leaves offscreen text in the tree and tapping its
    centre lands somewhere else entirely."""
    for n in nodes(xml if xml is not None else ui()):
        hay = (n['text'] or '') + '\x00' + (n['desc'] or '')
        if n['w'] <= 0 or n['h'] <= 0:
            continue
        if (needle == n['text'] or needle == n['desc']) if exact else (needle.lower() in hay.lower()):
            return n
    return None

def find_id(needle, xml=None):
    """By resource-id, which is how anything with a testID should be addressed.
    Text is ambiguous in this app -- the tab bar carries both a label node and an
    accessible wrapper with the same words, and one of them is zero-sized."""
    for n in nodes(xml if xml is not None else ui()):
        if needle in (n['id'] or '') and n['w'] > 0 and n['h'] > 0:
            return n
    return None

def tap_id(needle, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        n = find_id(needle)
        if n:
            tap(n)
            return n
        time.sleep(0.8)
    raise AssertionError('never found a tappable id matching "%s" in %ss' % (needle, timeout))

def tap(n):
    sh('adb', 'shell', 'input', 'tap', str(n['cx']), str(n['cy']))

def tap_text(needle, timeout=20, exact=False):
    end = time.time() + timeout
    while time.time() < end:
        n = find(needle, exact=exact)
        if n:
            tap(n)
            return n
        time.sleep(0.8)
    raise AssertionError('never found a tappable "%s" in %ss' % (needle, timeout))

def wait_text(needle, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if find(needle):
            return True
        time.sleep(0.7)
    return False

def swipe_up(px=900):
    sh('adb', 'shell', 'input', 'swipe', '540', '1700', '540', str(1700 - px), '350')

def scroll_to(needle, tries=12, exact=False):
    """Scroll until the text is on screen. Returns the node, or raises with what
    WAS on screen, because "not found" alone never says whether the scroll ran
    out or the label is simply different from what the test expected."""
    for _ in range(tries):
        n = find(needle, exact=exact)
        if n:
            return n
        swipe_up()
        time.sleep(0.5)
    seen = [x['text'] for x in nodes(ui()) if x['text']]
    raise AssertionError('scrolled %d times without finding %r; on screen: %s'
                         % (tries, needle, seen[:14]))

def type_text(s):
    """adb input text cannot carry every character; the ones in an email and a
    password that it mangles are escaped rather than hoped over."""
    esc = s.replace('%', '\\%').replace(' ', '%s').replace('&', '\\&').replace('(', '\\(').replace(')', '\\)')
    sh('adb', 'shell', 'input', 'text', esc)

LOG = os.path.expanduser('~/expo-logs.txt')

def log_mark():
    """Where the log ends right now.

    App console output goes to Metro, not logcat -- `expo start | tee` is what
    puts it on disk -- so a scenario marks the end of the file, acts, and reads
    only what its own actions produced."""
    return os.path.getsize(LOG)

def log_since(mark, grep=None, wait=0):
    if wait:
        time.sleep(wait)
    with open(LOG, 'r', errors='replace') as f:
        f.seek(mark)
        out = f.read()
    lines = out.split('\n')
    if grep:
        rx = re.compile(grep)
        lines = [l for l in lines if rx.search(l)]
    return [l.rstrip() for l in lines if l.strip()]

def log_wait(mark, pattern, timeout=60):
    """Wait for a line to appear, returning it and how long it took. The timing
    IS the measurement for the latency scenarios, so it is returned rather than
    logged and thrown away."""
    rx = re.compile(pattern)
    t0 = time.time()
    while time.time() - t0 < timeout:
        for l in log_since(mark):
            if rx.search(l):
                return l.rstrip(), time.time() - t0
        time.sleep(0.4)
    return None, time.time() - t0

def logcat_clear():
    sh('adb', 'logcat', '-c')

def logcat(since_marker=None):
    return sh('adb', 'logcat', '-d', '-v', 'time', 'ReactNativeJS:V', '*:S', t=120)

def screenshot(name):
    out = os.path.join(os.path.dirname(__file__), '_shots', name + '.png')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'wb') as f:
        f.write(subprocess.run(['adb', 'exec-out', 'screencap', '-p'],
                               capture_output=True, timeout=60).stdout)
    return out

def restart_app():
    sh('adb', 'shell', 'am', 'force-stop', PKG)
    time.sleep(1)
    sh('adb', 'shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1')
    time.sleep(6)

if __name__ == '__main__':
    if sys.argv[1:] and sys.argv[1] == 'dump':
        for n in nodes(ui()):
            if n['text'] or n['desc']:
                print('%-40s %-30s %s' % ((n['text'] or '')[:40], (n['desc'] or '')[:30], n['id'][-30:]))

def tap_xy(x, y):
    """Tap a raw device coordinate.

    Needed because the Add-to-Cart sheet does not surface in the accessibility
    tree -- uiautomator returns the screen behind it -- so its controls are
    located from a screenshot instead. Device pixels, not the scaled coordinates
    a viewer shows.
    """
    sh('adb', 'shell', 'input', 'tap', str(int(x)), str(int(y)))

def sign_in(email_xy, pass_xy, submit_xy, c, settle=1.5, tab=True):
    """Type an email and password into a store's form and submit.

    TAB BETWEEN THE FIELDS, not a second tap. Focusing the email field raises
    the keyboard, and on every form so far the keyboard then covers the password
    field -- so the tap meant for the password lands on a key instead and only
    the email is ever filled. TAB is where the form says the next field is.

    The keyboard is dismissed with BACK (keyevent 4, not 111) before the submit
    tap, because with it up the tap lands on the keyboard.
    """
    tap_xy(*email_xy); time.sleep(settle)
    type_text(c['email']); time.sleep(settle)
    if tab:
        sh('adb', 'shell', 'input', 'keyevent', '61')
    else:
        tap_xy(*pass_xy)
    time.sleep(settle)
    type_text(c['password']); time.sleep(settle)
    hide_keyboard(); time.sleep(settle)
    mark = log_mark()
    tap_xy(*submit_xy)
    return mark

def clear_field(xy, n=90):
    """Empty a text field.

    MOVE_END first: a bare run of backspaces deletes from wherever the caret
    happened to land, which on a tap into the middle of an existing value leaves
    a prefix behind -- "ail.com stephen..." was a real one, and the form then
    rejected it as an invalid address rather than failing in any obvious way.
    """
    tap_xy(*xy); time.sleep(1)
    sh('adb', 'shell', 'input', 'keyevent', '123')      # MOVE_END
    for _ in range(n):
        sh('adb', 'shell', 'input', 'keyevent', '67')   # DEL
    time.sleep(0.5)

def dismiss_google_save():
    """Decline Google Password Manager's offer to store what we just typed.

    It appears after every store sign-in and covers the page. Declined rather
    than accepted: these are Stephen's real credentials and a test run has no
    business copying them into another store.
    """
    n = find('Not now')
    if n:
        tap(n)
        time.sleep(1.5)
        return True
    return False

def signed_in_rerun(chip):
    """Scenario 3: close the sheet, start the same run again, and report what
    the app decided. A pass is 'known logged in' with no login step at all."""
    tap_xy(1007, 196); time.sleep(4)
    n = find(chip, exact=True)
    if n: tap(n); time.sleep(3)
    tap_id('meal-card', timeout=25); time.sleep(2)
    mark = log_mark()
    tap_id('floating-add-to-cart', timeout=25); time.sleep(2)
    tap_xy(539, 2113)
    line, dt = log_wait(mark, r'known logged in|Sign in to continue|surfacing login|said logged out', 90)
    return line, dt, log_since(mark, r'prewarm:|step= login|searching')

def keyboard_up():
    out = sh('adb', 'shell', 'dumpsys', 'input_method')
    return 'mInputShown=true' in out

def hide_keyboard():
    """BACK, but only when the keyboard is actually up.

    Pressing BACK with the keyboard already down closes the whole cart sheet and
    throws the sign-in away. That cost two Albertsons attempts before it was
    worth a check rather than a habit.
    """
    if keyboard_up():
        sh('adb', 'shell', 'input', 'keyevent', '4')
        time.sleep(1.2)
        return True
    return False
