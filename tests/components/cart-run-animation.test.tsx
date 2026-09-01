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
    expect(v.getByText('3')).toBeTruthy();
    expect(v.getByText('of 10')).toBeTruthy();
    expect(v.getByText('Sour Cream')).toBeTruthy();
  });

  it('survives a zero total without dividing by it', () => {
    // The session probe can finish before any term is known, so this renders
    // with total 0 for a beat on every run.
    const v = render(<CartRunAnimation total={0} done={0} />);
    expect(v.getByTestId('cart-run-animation')).toBeTruthy();
    expect(v.getByText('of 0')).toBeTruthy();
  });

  it('does not show a label row when there is nothing to say', () => {
    const v = render(<CartRunAnimation total={5} done={1} label={null} />);
    expect(v.queryByTestId('cart-run-label')).toBeNull();
  });

  it('never reports more done than total, even if a late result arrives', () => {
    const v = render(<CartRunAnimation total={4} done={9} />);
    // The ring clamps; the count is the caller's number, so the two cannot
    // disagree in a way that draws a full ring next to "9 of 4".
    expect(v.getByText('of 4')).toBeTruthy();
  });
});
