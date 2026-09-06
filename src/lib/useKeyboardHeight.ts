import { useEffect, useState } from 'react';
import { Keyboard, Platform, useWindowDimensions } from 'react-native';

/**
 * How much of the screen the keyboard is currently covering.
 *
 * WHY THIS EXISTS. The store picker is an absolutely positioned overlay pinned
 * to the bottom of its parent, which is what makes it a bottom sheet. Nothing
 * about that layout moves when the keyboard opens, so tapping its search box
 * put the keyboard straight over the results it was filtering: you could type
 * and not see what you had matched.
 *
 * `KeyboardAvoidingView` is the reflex and it is the wrong tool here. It works
 * by padding or resizing a container that owns its own layout, and this sheet
 * is `position: absolute` inside a Modal, where the container has no height of
 * its own to give back. Measuring the keyboard and moving the sheet by exactly
 * that much is the version that behaves the same on both platforms.
 *
 * WHICH EVENTS, and it is not the same pair on each platform. iOS fires
 * `keyboardWillShow` ahead of the animation, so the sheet moves WITH the
 * keyboard rather than after it. Android does not fire the `Will` events at
 * all under most soft-input modes, so it has to use `keyboardDidShow` and
 * accepts a frame of lag. Subscribing to both on iOS would double-fire.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const show = Keyboard.addListener(showEvent, (e) => {
      // `endCoordinates.height` rather than a constant. Keyboard height varies
      // with the language, whether a suggestion strip is showing, and whether
      // the user is on a hardware keyboard, where it is near zero.
      setHeight(e.endCoordinates?.height ?? 0);
    });
    const hide = Keyboard.addListener(hideEvent, () => setHeight(0));

    return () => { show.remove(); hide.remove(); };
  }, []);

  return height;
}

/**
 * The style a bottom-anchored sheet needs so the keyboard does not cover it.
 *
 * Two values, and the second is the one that is easy to miss. Lifting the sheet
 * by the keyboard height is not enough on its own: `maxHeight: '70%'` resolves
 * against the FULL screen, so on a tall keyboard a sheet that is already at its
 * cap gets pushed straight off the top and takes its title and close button
 * with it. Measured against a 800pt screen and a 320pt keyboard, a 70% sheet
 * would start 80pt above the top of the display.
 *
 * So the cap becomes whichever is smaller: the fraction it was always allowed,
 * or what is actually left above the keyboard. With no keyboard the second term
 * is the whole screen and the behaviour is exactly as before.
 *
 * @param fraction how much of the screen the sheet may fill, keyboard aside.
 */
export function useBottomSheetLift(fraction = 0.7): { marginBottom: number; maxHeight: number } {
  const keyboardHeight = useKeyboardHeight();
  const { height } = useWindowDimensions();
  return {
    marginBottom: keyboardHeight,
    // The 24 is breathing room, so the sheet never sits flush against the top
    // of the keyboard with its last row half-clipped.
    maxHeight: Math.min(height * fraction, height - keyboardHeight - 24),
  };
}
