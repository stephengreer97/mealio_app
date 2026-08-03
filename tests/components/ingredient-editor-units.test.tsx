// The unit picker's vocabulary (MEAL-71 / MEAL-89).
//
// The server canonicalises every ingredient to UNITS + COOK_UNITS — the eleven
// measured units plus the eight a cook writes that convert to nothing. This
// picker offered the twelve measured ones (plus "Qty") and no more, so a row
// that arrived as `{unit: 'cloves', measure: '3'}` displayed correctly and then
// had no option to select: opening the picker was a one-way trip out of the
// unit, with no way back to it.
//
// It matters here more than anywhere else the editor is used, because the
// review queue is the screen whose whole job is catching a wrong measure — and
// the failure COOK_UNITS was added for is precisely the one it would introduce:
// "3 cloves garlic" collapsing to a count of 3 tells the cart to buy three
// HEADS of garlic.

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  const icon = (props: any) => RealReact.createElement(RealText, null, props.name);
  return { Ionicons: icon, Feather: icon };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

import IngredientEditor from '../../src/components/IngredientEditor';
import type { Ingredient } from '../../src/types';

/** The eight the server canonicalises to and the picker has to be able to reach. */
const COOK_UNITS = ['cloves', 'cans', 'bunches', 'sprigs', 'pinches', 'handfuls', 'grinds', 'slices'];

function garlicInCloves(): Ingredient {
  return { ingredientName: 'garlic', qty: 1, unit: 'cloves', measure: '3', searchTerm: null, productQty: 1 };
}

function mount(ingredients: Ingredient[]) {
  const onChange = jest.fn();
  const view = render(<IngredientEditor ingredients={ingredients} onChange={onChange} />);
  return { ...view, onChange };
}

describe('a cook’s unit is selectable, not only displayable', () => {
  it('shows the unit the row arrived with', async () => {
    const { getByText } = mount([garlicInCloves()]);
    expect(getByText('cloves')).toBeTruthy();
  });

  it('offers every unit the server canonicalises to', async () => {
    const { getAllByText, queryAllByText } = mount([garlicInCloves()]);

    // Open the picker on the one row. The row's own button carries the current
    // unit too, which is why presence is counted rather than matched uniquely.
    fireEvent.press(getAllByText('cloves')[0]);

    const measured = ['qty', 'cups', 'fl oz', 'g', 'kg', 'L', 'lb', 'mg', 'ml', 'oz', 'tbsp', 'tsp'];
    for (const unit of [...measured, ...COOK_UNITS]) {
      expect(queryAllByText(unit).length).toBeGreaterThan(0);
    }
  });

  it('lets a creator get back to the unit after touching the picker', async () => {
    // The trap was one-way rather than immediate: a row left alone kept
    // `cloves`, so the bug only bit the creator who actually used the control —
    // and then there was no way to undo it.
    const { getAllByText, getByText, onChange } = mount([garlicInCloves()]);

    fireEvent.press(getAllByText('cloves')[0]);
    fireEvent.press(getByText('tbsp'));
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ unit: 'tbsp' })]);

    fireEvent.press(getAllByText('tbsp')[0]);
    fireEvent.press(getByText('cloves'));

    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ ingredientName: 'garlic', unit: 'cloves', measure: '3' }),
    ]);
  });

  it('keeps a cook’s unit off the countable branch', async () => {
    // `qty` is the one unit anything downstream branches on: it picks between
    // two display formats and it is what makes the amount a PACKAGE count.
    // A cook's unit must not land there — that is the "three heads of garlic"
    // bug itself.
    const { getAllByText, getByText, onChange } = mount([
      { ingredientName: 'garlic', qty: 1, unit: 'qty', measure: null, searchTerm: null, productQty: 1 },
    ]);

    fireEvent.press(getAllByText('qty')[0]);
    fireEvent.press(getByText('cloves'));

    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ unit: 'cloves', qty: 1, productQty: 1 }),
    ]);
  });
});
