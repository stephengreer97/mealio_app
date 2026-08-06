// MEAL-64: tap-vs-drag on the floating product preview.
//
// The thumbnail's PanResponder CAPTURES the touch on start (it has to — see
// useDraggablePreview), so no Touchable above or below it ever sees a press and
// there is no onPress to hang the full-screen viewer off. The decision has to be
// made from inside the responder, from the released gesture's travel, and this
// is that decision. Get the slop wrong in either direction and the feature
// breaks in a way no type or render test would catch: too tight and a real tap
// reads as a drag (nothing opens), too loose and a deliberate drag opens the
// viewer on release.

import { isTapGesture, TAP_SLOP_PX } from '../../src/lib/useDraggablePreview';

describe('isTapGesture', () => {
  it('treats a dead-still touch as a tap', () => {
    expect(isTapGesture(0, 0)).toBe(true);
  });

  it('treats a finger roll within the slop as a tap, in any direction', () => {
    expect(isTapGesture(TAP_SLOP_PX, TAP_SLOP_PX)).toBe(true);
    expect(isTapGesture(-TAP_SLOP_PX, -TAP_SLOP_PX)).toBe(true);
    expect(isTapGesture(3, -5)).toBe(true);
  });

  it('treats travel past the slop on either axis as a drag', () => {
    expect(isTapGesture(TAP_SLOP_PX + 1, 0)).toBe(false);
    expect(isTapGesture(0, TAP_SLOP_PX + 1)).toBe(false);
    expect(isTapGesture(-(TAP_SLOP_PX + 1), 0)).toBe(false);
    expect(isTapGesture(0, -(TAP_SLOP_PX + 1))).toBe(false);
  });

  it('treats a deliberate reposition as a drag', () => {
    expect(isTapGesture(120, 240)).toBe(false);
  });

  it('keeps the slop small enough not to swallow a real drag', () => {
    // A thumbnail is 80–88px; a slop anywhere near that would make short
    // repositions open the viewer instead of moving the preview.
    expect(TAP_SLOP_PX).toBeLessThan(20);
  });
});
