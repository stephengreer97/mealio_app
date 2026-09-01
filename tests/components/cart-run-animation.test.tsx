// The screen that replaces the WebView during a network run.
//
// It plays a 25-frame sprite sheet of a Mealio bag filling up. The thing worth
// testing is not that it animates — it is that the FRAME IS THE PROGRESS. A bag
// that looks two-thirds full has to mean two-thirds done, or the screen is
// lying more convincingly than a spinner would.

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

  it('shows how many of how many, not a spinner', () => {
    const v = render(<CartRunAnimation total={10} done={3} label="Sour Cream" />);
    expect(v.getByTestId('cart-run-count')).toHaveTextContent('3/10');
    expect(v.getByText('Sour Cream')).toBeTruthy();
  });

  it('shows no count at all when there is no denominator yet', () => {
    // The login check has nothing to count. "0/0" reads as broken.
    const v = render(<CartRunAnimation total={0} done={0} />);
    expect(v.queryByTestId('cart-run-count')).toBeNull();
    expect(v.getByTestId('cart-run-animation')).toBeTruthy();
  });

  it('takes a headline, so the login check does not claim to be filling a cart', () => {
    const v = render(<CartRunAnimation total={0} done={0} title="Checking your H-E-B account" />);
    expect(v.getByText('Checking your H-E-B account')).toBeTruthy();
    expect(v.queryByText('Filling your cart')).toBeNull();
  });

  it('does not show a label row when there is nothing to say', () => {
    const v = render(<CartRunAnimation total={5} done={1} label={null} />);
    expect(v.queryByTestId('cart-run-label')).toBeNull();
  });

  // Which frame is showing, derived from how far the sheet has been slid.
  const DISPLAY_H = 232;
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
    const v = render(<CartRunAnimation total={10} done={0} />);
    settle();
    expect(frameOf(v)).toBe(0);
  });

  it('a fuller bag means more done — the frame IS the progress', () => {
    const empty = render(<CartRunAnimation total={10} done={0} />);
    const part = render(<CartRunAnimation total={10} done={5} />);
    const full = render(<CartRunAnimation total={10} done={10} />);
    settle();
    expect(frameOf(empty)).toBeLessThan(frameOf(part));
    expect(frameOf(part)).toBeLessThan(frameOf(full));
    // The extremes are the extremes, not merely ordered.
    expect(frameOf(empty)).toBe(0);
    expect(frameOf(full)).toBe(SHEET.frames - 1);
  });

  it('never runs past the last frame, even if more lands than was asked for', () => {
    const v = render(<CartRunAnimation total={4} done={99} />);
    settle();
    // Clamped to the last frame; a bag cannot get fuller than full.
    expect(frameOf(v)).toBe(SHEET.frames - 1);
    expect(v.getByTestId('cart-run-count')).toHaveTextContent('99/4');
  });

  it('drops the 15 frames Stephen rejected — the sheet is the trimmed 25', () => {
    expect(SHEET.frames).toBe(25);
    expect(SHEET.cols * SHEET.rows).toBeGreaterThanOrEqual(SHEET.frames);
  });
});
