/**
 * MEAL-218's glow, on the preference picker.
 *
 * Stephen, after the canary's curation stalled on H-E-B bananas: "its because
 * HEB has a preference modal it wants you to select... I want the unset
 * preference modal section to have the same glowing border as the unset qty".
 *
 * The two controls have the same job and the same failure. Both block the
 * primary until answered, and both are easy to scroll past -- an automated
 * curation pass sat on that screen tapping a disabled button until it gave up,
 * which is exactly what a person does when they cannot see what is being asked
 * of them. The preference said "required" in red, which is a LABEL; the glow is
 * the thing the eye actually lands on.
 */
import { render } from '@testing-library/react-native';

jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return {
    WebView: RealReact.forwardRef((props: any, ref: any) => {
      RealReact.useImperativeHandle(ref, () => ({ injectJavaScript: () => {}, stopLoading: () => {} }));
      return RealReact.createElement(RealView, props);
    }),
  };
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'WebViewCartSheet.tsx'), 'utf8');

describe('the unset preference section glows like an unset quantity', () => {
  it('uses the same animated values the quantity glow uses', () => {
    // Not a second amber, and not a second animation: the same interpolations,
    // so the two never breathe out of step on a screen showing both.
    const block = src.slice(src.indexOf('testID="pref-glow"'), src.indexOf('testID="pref-glow"') + 700);
    expect(block).toContain('qtyIdleBorder');
    expect(block).toContain('qtyIdleBg');
  });

  it('wears off once a preference is chosen', () => {
    // An animation that never ends stops being noticed -- the same reason the
    // quantity glow is gated on the quantity being unset.
    const block = src.slice(src.indexOf('testID="pref-glow"'), src.indexOf('testID="pref-glow"') + 700);
    expect(block).toContain('!selectedPreference ?');
    expect(block).not.toMatch(/borderWidth:\s*2\s*,/);
  });

  it('is the brand red, and never the flash red or the store colour', () => {
    // Was amber until 2026-09-09 (Stephen: "make the qty glow mealio red
    // instead of yellow"). It follows the quantity glow wherever that goes,
    // which is the point of sharing the values -- two invitation colours on one
    // screen would be worse than either.
    //
    // Still NOT the flash red (#ef4444): that one answers a press, and this one
    // invites it. They are now told apart by tempo and by living on separate
    // elements rather than by hue. And still not the STORE colour -- this is the
    // app saying something is missing, not the store saying anything.
    expect(src).toContain("rgba(221,0,49,0.25)");
    expect(src).not.toContain("rgba(245,158,11,0.25)");
    const block = src.slice(src.indexOf('testID="pref-glow"'), src.indexOf('testID="pref-glow"') + 700);
    expect(block).not.toContain('#ef4444');
    expect(block).not.toContain('storeColor');
  });

  it('rings the box from outside, leaving its own border alone', () => {
    // Two elements because the box already has a border; one border cannot show
    // both the box and the invitation.
    const block = src.slice(src.indexOf('testID="pref-glow"'), src.indexOf('testID="pref-glow"') + 900);
    expect(block).toContain('styles.prefBox');
    expect(block).toContain('marginHorizontal: 0');
  });
});
