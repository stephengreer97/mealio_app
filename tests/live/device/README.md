# Driving the Pixel through the login scenarios

`drive.py` is adb plus observation: dump the view hierarchy, find a node, tap
it, read what the app said. `creds.py` reads `~/store_logins.txt` and **never
prints a value** -- the only things it will put on a terminal are a store name,
which fields exist, and their lengths.

Nothing here is a jest test. These scenarios need a real device, a real network
and real accounts, so they are run deliberately and their evidence is the app's
own log, not an assertion.

## Reading the app's log

Console output goes to Metro, not logcat, so `expo start | tee ~/expo-logs.txt`
is what puts it on disk. `log_mark()` takes the current end of that file and
`log_since(mark)` returns only what your own actions produced.

## Before trusting any run

Check the phone is running the code you think it is. Metro serves the checkout,
not the merge:

    curl -s "http://localhost:8081/index.bundle?platform=android&dev=true&minify=false" \
      -o /tmp/bundle.js && grep -c acctGuest /tmp/bundle.js

## The four scenarios

Run in order; each leaves the state the next one needs.

1. **Signed out prompts.** Account -> Log Out of Grocery Stores, then start a
   run. Expect a login prompt, and expect `prewarm: said logged out -- checking
   for ourselves before surfacing login` rather than a prompt on the prewarm's
   word.
2. **Signing in is noticed quickly.** Sign in inside the WebView. Expect
   `the page moved under ask #N -- that context is gone, asking the new one`
   within milliseconds of the storefront landing, then a verdict. Measured on
   ALDI 2026-09-07: 1.66s from landing to searching.
3. **Signed in does not prompt.** Run again. Expect
   `prewarm: known logged in -- skipping login check` and no login step at all.
4. **Logging out is noticed.** Log Out of Grocery Stores, run again, expect (1).

## Gotchas that cost time

- The Add-to-Cart sheet does **not** appear in the accessibility tree.
  uiautomator returns the screen behind it, so its controls are located from a
  screenshot and tapped with `tap_xy` in DEVICE pixels.
- `input keyevent 111` does not dismiss the keyboard; `4` (back) does. A submit
  tap with the keyboard up lands on the keyboard.
- Store login forms re-render and clear the password field. Re-type and submit
  with `keyevent 66` rather than tapping the button.
- The My Meals chip row lists only stores with saved meals.
