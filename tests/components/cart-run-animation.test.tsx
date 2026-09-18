// The screen that replaces the WebView during a network run.
//
// It plays a sprite sheet of a Mealio bag filling up. The thing worth testing is
// not that it animates — it is that the FRAME IS THE PROGRESS. A bag that looks
// two-thirds full has to mean two-thirds done, or the screen is lying more
// convincingly than a spinner would.
//
// Since 2026-09-18 the screen follows the launch video (brag-output): a heading,
// the meal, a bold count, a red bar and a green tick at the end. The count is
// the caller's to make honest (the cart sheet counts only CONFIRMED adds); what
// is tested here is that the component shows what it is given and nothing more.

import { render, act } from '@testing-library/react-native';
import React from 'react';
import CartRunAnimation from '../../src/components/CartRunAnimation';
import SHEET from '../../assets/anim/bag-fill.json';

// The frame steps on a timer, and each step schedules the next one from the
// re-render it causes — so the clock has to be walked forward in beats, not
// jumped. One big advance fires exactly one step.
const settle = () => {
  for (let i = 0; i < 40; i++) act(() => { jest.advanceTimersByTime(60); });
};

describe('CartRunAnimation', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('shows the label, and no counter unless it is given one', () => {
    const v = render(<CartRunAnimation progress={0.3} label="Sour Cream" />);
    expect(v.getByText('Sour Cream')).toBeTruthy();
    expect(v.queryByTestId('cart-run-count')).toBeNull();
  });

  it('shows the count it is given, as the video does', () => {
    const v = render(<CartRunAnimation progress={0.6} count={{ done: 3, total: 12, verb: 'added' }} />);
    expect(v.getByTestId('cart-run-count').props.children.join('')).toBe('3 of 12 added');
  });

  it('never counts past the total', () => {
    const v = render(<CartRunAnimation progress={1} count={{ done: 14, total: 12, verb: 'added' }} />);
    expect(v.getByTestId('cart-run-count').props.children.join('')).toBe('12 of 12 added');
  });

  it('shows no count for an empty list', () => {
    const v = render(<CartRunAnimation progress={0.1} count={{ done: 0, total: 0, verb: 'added' }} />);
    expect(v.queryByTestId('cart-run-count')).toBeNull();
  });

  it('has a bar while progress is known, and none during the login check', () => {
    expect(render(<CartRunAnimation progress={0.4} />).queryByTestId('cart-run-bar')).toBeTruthy();
    expect(render(<CartRunAnimation progress={null} />).queryByTestId('cart-run-bar')).toBeNull();
  });

  it('turns the quiet line into the green tick only when the run is complete', () => {
    const midway = render(<CartRunAnimation progress={0.7} label="Adding 12 ingredients…" doneText="All 12 in your cart" />);
    expect(midway.queryByTestId('cart-run-done')).toBeNull();
    expect(midway.getByText('Adding 12 ingredients…')).toBeTruthy();

    const complete = render(<CartRunAnimation progress={1} label="Adding 12 ingredients…" doneText="All 12 in your cart" />);
    expect(complete.getByTestId('cart-run-done')).toBeTruthy();
    expect(complete.getByText('All 12 in your cart')).toBeTruthy();
    expect(complete.queryByText('Adding 12 ingredients…')).toBeNull();

    // A full bag with no doneText (a run that missed an item) claims nothing.
    const partial = render(<CartRunAnimation progress={1} label="Adding 12 ingredients…" />);
    expect(partial.queryByTestId('cart-run-done')).toBeNull();
  });

  it('shows the meal under the heading', () => {
    const v = render(<CartRunAnimation progress={0.2} title="Adding to your cart" subtitle="Fish Tacos with Chipotle Slaw" />);
    expect(v.getByTestId('cart-run-title').props.children).toBe('Adding to your cart');
    expect(v.getByTestId('cart-run-subtitle').props.children).toBe('Fish Tacos with Chipotle Slaw');
  });

  it('renders with no progress at all — the login check has nothing to count', () => {
    const v = render(<CartRunAnimation progress={null} />);
    expect(v.getByTestId('cart-run-animation')).toBeTruthy();
  });

  it('takes a headline, so the login check does not claim to be filling a cart', () => {
    const v = render(<CartRunAnimation progress={null} title="Checking your H-E-B account" />);
    expect(v.getByText('Checking your H-E-B account')).toBeTruthy();
    expect(v.queryByText('Filling your cart')).toBeNull();
  });

  it('does not show a label row when there is nothing to say', () => {
    const v = render(<CartRunAnimation progress={0.2} label={null} />);
    expect(v.queryByTestId('cart-run-label')).toBeNull();
  });

  // Which frame is showing, derived from how far the sheet has been slid.
  const DISPLAY_H = 250;
  const DISPLAY_W = Math.round(SHEET.frameWidth * (DISPLAY_H / SHEET.frameHeight));
  const frameOf = (v: ReturnType<typeof render>) => {
    const img = v.getByTestId('bag-frame-window').children[0] as unknown as
      { props: { style: Record<string, unknown> } };
    const t = (img.props.style.transform ?? []) as Array<Record<string, number>>;
    const col = Math.round(Math.abs(t.find((x) => 'translateX' in x)?.translateX ?? 0) / DISPLAY_W);
    const row = Math.round(Math.abs(t.find((x) => 'translateY' in x)?.translateY ?? 0) / DISPLAY_H);
    return row * SHEET.cols + col;
  };

  it('starts on the empty frame', () => {
    const v = render(<CartRunAnimation progress={0} />);
    settle();
    expect(frameOf(v)).toBe(0);
  });

  it('a fuller bag means more done — the frame IS the progress', () => {
    const empty = render(<CartRunAnimation progress={0} />);
    const part = render(<CartRunAnimation progress={0.5} />);
    const full = render(<CartRunAnimation progress={1} />);
    settle();
    expect(frameOf(empty)).toBeLessThan(frameOf(part));
    expect(frameOf(part)).toBeLessThan(frameOf(full));
    // The extremes are the extremes, not merely ordered.
    expect(frameOf(empty)).toBe(0);
    expect(frameOf(full)).toBe(SHEET.frames - 1);
  });

  it('never runs past the last frame, even if more lands than was asked for', () => {
    const v = render(<CartRunAnimation progress={4.2} />);
    settle();
    // Clamped to the last frame; a bag cannot get fuller than full.
    expect(frameOf(v)).toBe(SHEET.frames - 1);
  });

  it('the halfway frame is the handover — search fills the first half, writes the second', () => {
    // The bug this replaces: search counted 18 of 18 and the bag filled, then
    // the first write arrived counting 1 of 18 and the bag EMPTIED. One run is
    // one sweep now, so the end of the search and the start of the writes are
    // the same picture.
    const endOfSearch = render(<CartRunAnimation progress={0.5} />);
    const startOfAdds = render(<CartRunAnimation progress={0.5} />);
    settle();
    expect(frameOf(endOfSearch)).toBe(frameOf(startOfAdds));
    // And it is genuinely mid-fill, not parked at either end.
    expect(frameOf(endOfSearch)).toBeGreaterThan(0);
    expect(frameOf(endOfSearch)).toBeLessThan(SHEET.frames - 1);
  });

  it('the sheet metadata describes a grid that actually holds every frame', () => {
    // bag-fill.webp is the WHOLE source sheet, in the sheet's own order —
    // Stephen's instruction on 2026-09-01, reversing an earlier build of mine
    // that curated a monotonic subsequence out of it. The sheet is the artwork
    // and its order is the artwork's order. If someone rebuilds it, these are
    // the things the component assumes.
    expect(SHEET.frames).toBeGreaterThan(1);
    expect(SHEET.cols * SHEET.rows).toBeGreaterThanOrEqual(SHEET.frames);
    // The component addresses frames by translating the image, so the declared
    // sheet size must match the grid exactly or every frame lands off by a bit.
    expect(SHEET.sheetWidth).toBe(SHEET.frameWidth * SHEET.cols);
    expect(SHEET.sheetHeight).toBe(SHEET.frameHeight * SHEET.rows);
  });

  it('shows a stall note when one is given, and nothing when it is not', () => {
    const quiet = render(<CartRunAnimation progress={0.2} />);
    expect(quiet.queryByTestId('cart-run-note')).toBeNull();

    const stalled = render(<CartRunAnimation progress={0.2} note="Still working — this one is taking longer than usual" />);
    expect(stalled.getByTestId('cart-run-note').props.children)
      .toContain('taking longer than usual');
  });
});

describe('the title says nothing unless there is something to say', () => {
  // "Filling your cart" was the default, so it showed for the whole run —
  // including the parts that are not filling anything: checking the login,
  // searching, and a Choose Products run that never adds at all.
  it('renders no title when none is given', () => {
    const { queryByText } = render(<CartRunAnimation progress={0.5} label={null} note={null} />);
    expect(queryByText('Filling your cart')).toBeNull();
  });

  it('renders the one it is given', () => {
    const { getByText } = render(
      <CartRunAnimation progress={null} label={null} note={null} title="Checking your H-E-B account" />,
    );
    expect(getByText('Checking your H-E-B account')).toBeTruthy();
  });
});
