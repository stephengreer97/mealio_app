// THE STORE PICKER IS A BOTTOM SHEET, AND THE KEYBOARD SAT ON TOP OF IT.
//
// Stephen: "select a store dropdown, then click on search bar. Keyboard is
// covering up the results."
//
// The picker is an absolutely positioned overlay pinned to the bottom of its
// parent, which is what makes it a sheet. Nothing in that layout moves when the
// keyboard opens, so tapping its search box put the keyboard straight over the
// list it was filtering: you could type and not see what you had matched.
//
// TWO THINGS HAVE TO BE RIGHT and the second is the one that is easy to miss.
// Lifting by the keyboard height is not enough on its own, because
// `maxHeight: '70%'` resolves against the FULL screen: a sheet already at its
// cap gets pushed off the TOP and takes its title and close button with it.
import { renderHook, act } from '@testing-library/react-native';

let showCb: ((e: unknown) => void) | null = null;
let hideCb: (() => void) | null = null;

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ height: 800, width: 400 }),
  Keyboard: {
    addListener: (event: string, cb: (e: unknown) => void) => {
      if (event.includes('Show')) showCb = cb as never;
      if (event.includes('Hide')) hideCb = cb as never;
      return { remove: jest.fn() };
    },
  },
}));

import { useKeyboardHeight, useBottomSheetLift } from '../../src/lib/useKeyboardHeight';

const openKeyboard = (height: number) =>
  act(() => { showCb?.({ endCoordinates: { height } }); });
const closeKeyboard = () => act(() => { hideCb?.(); });

beforeEach(() => { showCb = null; hideCb = null; });

describe('the measured keyboard height', () => {
  it('is zero until the keyboard opens', () => {
    const { result } = renderHook(() => useKeyboardHeight());
    expect(result.current).toBe(0);
  });

  it('is what the event REPORTED, not a constant', () => {
    // Keyboard height varies with the language, whether a suggestion strip is
    // showing, and whether a hardware keyboard is attached, where it is close
    // to nothing. A hard-coded 300 would be wrong on most of those.
    const { result } = renderHook(() => useKeyboardHeight());
    openKeyboard(291);
    expect(result.current).toBe(291);
  });

  it('goes back to zero when the keyboard closes', () => {
    const { result } = renderHook(() => useKeyboardHeight());
    openKeyboard(320);
    closeKeyboard();
    expect(result.current).toBe(0);
  });

  it('survives an event with no coordinates rather than rendering NaN', () => {
    const { result } = renderHook(() => useKeyboardHeight());
    act(() => { showCb?.({}); });
    expect(result.current).toBe(0);
  });
});

describe('what the sheet gets', () => {
  it('changes nothing when there is no keyboard', () => {
    // The cap it always had: 70% of an 800pt screen.
    const { result } = renderHook(() => useBottomSheetLift());
    expect(result.current).toEqual({ marginBottom: 0, maxHeight: 560 });
  });

  it('lifts the sheet by exactly the keyboard height', () => {
    const { result } = renderHook(() => useBottomSheetLift());
    openKeyboard(320);
    expect(result.current.marginBottom).toBe(320);
  });

  it('SHRINKS the sheet so lifting it cannot push the header off the top', () => {
    // This is the half a "just add marginBottom" fix misses. 800pt screen,
    // 320pt keyboard: the old 70% cap is 560, the sheet bottom is at 480, so
    // its top would be at -80 and the title and close button would be gone.
    const { result } = renderHook(() => useBottomSheetLift());
    openKeyboard(320);
    expect(result.current.maxHeight).toBe(800 - 320 - 24);
    // And it genuinely fits: top edge is on screen with room to spare.
    const topEdge = 800 - result.current.marginBottom - result.current.maxHeight;
    expect(topEdge).toBeGreaterThanOrEqual(0);
  });

  it('keeps the fraction when the keyboard is small enough not to bind', () => {
    // A hardware keyboard reports almost nothing. The sheet should stay at its
    // designed size rather than growing to fill the screen.
    const { result } = renderHook(() => useBottomSheetLift());
    openKeyboard(60);
    expect(result.current.maxHeight).toBe(560);
  });

  it('honours a different fraction', () => {
    const { result } = renderHook(() => useBottomSheetLift(0.5));
    expect(result.current.maxHeight).toBe(400);
  });
});
