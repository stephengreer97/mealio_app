// The screen that replaces the WebView during a network run.
//
// Two things matter and neither is decoration. The ring must be a REAL fraction
// — the rail knows how many terms it asked for and how many landed, so a
// spinner would be throwing that away. And the count must be legible at a
// glance, because it is the only progress the user gets on a run that loads no
// pages.

import { render } from '@testing-library/react-native';
import React from 'react';
import CartRunAnimation from '../../src/components/CartRunAnimation';

describe('CartRunAnimation', () => {
  it('shows how many of how many, not a spinner', () => {
    const v = render(<CartRunAnimation total={10} done={3} label="Sour Cream" />);
    expect(v.getByTestId('cart-run-count')).toHaveTextContent('3/10');
    expect(v.getByText('Sour Cream')).toBeTruthy();
  });

  it('fills the bag in proportion to progress, so the pile IS the progress', () => {
    // The pile is what people read at a glance — a bag with eight things in it
    // is obviously further along than one with two, without reading a number.
    const none = render(<CartRunAnimation total={8} done={0} />);
    const half = render(<CartRunAnimation total={8} done={4} />);
    const full = render(<CartRunAnimation total={8} done={8} />);
    const inBag = (v: ReturnType<typeof render>) => v.queryAllByTestId('pile-item').length;
    expect(inBag(none)).toBe(0);
    expect(inBag(half)).toBeGreaterThan(0);
    expect(inBag(full)).toBeGreaterThan(inBag(half));
  });

  it('shows no count at all when there is no denominator yet', () => {
    // The login check has nothing to count, and the session probe answers before
    // any term is known. "0 of 0" reads as broken, so the ring sweeps and the
    // count is omitted entirely.
    const v = render(<CartRunAnimation total={0} done={0} />);
    expect(v.getByTestId('cart-run-animation')).toBeTruthy();
    expect(v.queryByTestId('cart-run-count')).toBeNull();
    expect(v.queryAllByTestId('pile-item')).toHaveLength(0);
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

  it('never reports more done than total, even if a late result arrives', () => {
    const v = render(<CartRunAnimation total={4} done={9} />);
    // The pile clamps at full; the count is the caller's number, so the two
    // cannot disagree in a way that draws a half-empty bag next to "9/4".
    expect(v.getByTestId('cart-run-count')).toHaveTextContent('9/4');
    expect(v.queryAllByTestId('pile-item').length).toBeLessThanOrEqual(8);
  });
});
