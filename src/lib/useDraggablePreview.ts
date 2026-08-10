import { useRef, useCallback, useState } from 'react';
import { Animated, PanResponder, LayoutChangeEvent } from 'react-native';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** How far (px) a gesture may travel and still read as a tap rather than a drag.
 *  Generous because the target is a small thumbnail and a finger rolls a few px
 *  between touch-down and lift. */
export const TAP_SLOP_PX = 8;

/**
 * Tap or drag? Decided from the released gesture's total travel.
 *
 * This has to live inside the responder. The thumbnail's PanResponder *captures*
 * the touch on start (it must — see the hook's note), so no Touchable wrapped
 * around or under it will ever see a press: there is no onPress to attach. The
 * only place that knows a tap happened is the release handler, which is why
 * MEAL-64's full-screen viewer is opened from there.
 */
export function isTapGesture(dx: number, dy: number): boolean {
  return Math.abs(dx) <= TAP_SLOP_PX && Math.abs(dy) <= TAP_SLOP_PX;
}

/**
 * Draggable floating product-preview thumbnail shared by the Choose Product flows
 * (WebViewCartSheet review step + ProductChooserSheet). The thumbnail is anchored
 * top-right of its container (style `top:0 / right:rightInset`) and this hook drives
 * a translate offset from there.
 *
 * Gestures are *captured* on start/move and we refuse termination, so the touch never
 * leaks to the ScrollView underneath (which caused the drag to jump a few pixels at a
 * time) or to the pageSheet modal (whose swipe-to-dismiss fired on a downward drag).
 *
 * Default resting position centers the thumbnail vertically on an anchor box (the grey
 * search-term box) once both the container and that box have reported their layout.
 * The clamp keeps it inside the container, so it can never ride up over the header/close X.
 *
 * `onTap` fires when a gesture ends without travelling (see isTapGesture) — the
 * capture above means a tap can only be recognised here, from the inside.
 */
export function useDraggablePreview(width: number, height: number, rightInset: number, onTap?: () => void) {
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const committed = useRef({ x: 0, y: 0 }); // last settled translate
  const container = useRef({ w: 0, h: 0 });
  const restY = useRef(0);                  // default translate-y that centers on the anchor
  const restOffset = useRef(0);             // extra downward nudge added to the default rest (per-flow)
  const moved = useRef(false);              // user has dragged this item — stop auto-centering
  // While a drag is active we disable the scroll view underneath. On iOS the native
  // UIScrollView pan gesture otherwise runs alongside this PanResponder (the JS
  // `onShouldBlockNativeResponder` flag isn't honored there), so the list would scroll
  // while you drag the thumbnail.
  const [scrollEnabled, setScrollEnabled] = useState(true);

  const bounds = useCallback(() => ({
    minX: -Math.max(0, container.current.w - rightInset - width),
    maxX: 0,
    minY: 0,
    maxY: Math.max(0, container.current.h - height),
  }), [width, height, rightInset]);

  const place = useCallback((x: number, y: number) => {
    const b = bounds();
    const cx = clamp(x, b.minX, b.maxX);
    const cy = clamp(y, b.minY, b.maxY);
    committed.current = { x: cx, y: cy };
    pan.setValue({ x: cx, y: cy });
  }, [bounds, pan]);

  const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
    container.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
    if (!moved.current) place(0, restY.current + restOffset.current);
  }, [place]);

  // The grey search-term box: center the thumbnail on it (until the user drags).
  const onAnchorLayout = useCallback((e: LayoutChangeEvent) => {
    const { y, height: h } = e.nativeEvent.layout;
    restY.current = Math.max(0, y + h / 2 - height / 2);
    if (!moved.current) place(0, restY.current + restOffset.current);
  }, [place, height]);

  const reset = useCallback(() => {
    moved.current = false;
    place(0, restY.current + restOffset.current);
  }, [place]);

  // Extra downward nudge for the default rest position, set per-flow (e.g. the
  // Pick a Substitute flow rests slightly lower than Choose Product). The clamp
  // in `place` keeps it on-screen. No-op once the user has dragged the thumbnail.
  const setDefaultOffset = useCallback((px: number) => {
    restOffset.current = px;
    if (!moved.current) place(0, restY.current + restOffset.current);
  }, [place]);

  // The responder is built once, so it would capture the first render's onTap
  // forever. Read it through a ref instead — the handler a parent passes closes
  // over state (which product is selected) and changes on every render.
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: () => setScrollEnabled(false),
      onPanResponderMove: (_, g) => {
        const b = bounds();
        pan.setValue({
          x: clamp(committed.current.x + g.dx, b.minX, b.maxX),
          y: clamp(committed.current.y + g.dy, b.minY, b.maxY),
        });
      },
      onPanResponderRelease: (_, g) => {
        setScrollEnabled(true);
        if (isTapGesture(g.dx, g.dy)) {
          // A tap is not a drag: snap back the few px the finger rolled and
          // leave `moved` alone, so the thumbnail keeps auto-centering on the
          // anchor for the next ingredient instead of being pinned by a tap.
          place(committed.current.x, committed.current.y);
          onTapRef.current?.();
          return;
        }
        moved.current = true;
        place(committed.current.x + g.dx, committed.current.y + g.dy);
      },
      onPanResponderTerminate: () => {
        pan.setValue(committed.current);
        setScrollEnabled(true);
      },
    })
  ).current;

  return {
    transform: pan.getTranslateTransform(),
    panHandlers: responder.panHandlers,
    onContainerLayout,
    onAnchorLayout,
    reset,
    setDefaultOffset,
    scrollEnabled, // pass to the scroll view under the thumbnail
  };
}
