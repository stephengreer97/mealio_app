// MEAL-164 — an edit to one row does not throw away another row's chosen weight.
//
// `IngredientEditor.emit` runs the WHOLE list back through `fromFormIng` on
// every keystroke. That used to rebuild each `Ingredient` from a literal, so any
// field the form did not hold was not merely un-editable — it was DELETED, on
// every row, by correcting a typo in an unrelated ingredient's name. Three were
// going that way:
//
//   • purchaseWeight — the weight a shopper CHOSE for a sold-by-weight item
//     (H-E-B Deli, Fish Market, bulk), remembered so the next run auto-adds that
//     amount instead of re-prompting;
//   • weightStep — the increment that weight is chosen in;
//   • dropdown — the product preference the shopper selected.
//
// Losing purchaseWeight means the next run adds a different amount than the
// user picked. That is the over/under-add failure the cart's governing
// principles exist to prevent, arriving through an edit screen rather than
// through the cart — which is why this is worth its own file rather than a case
// bolted onto the prep tests.
//
// The rebuilt array is what three writers persist: MealDetailSheet.handleSave,
// CreatorPortalScreen, and creatorDrafts.edit from the draft review queue.
//
// MEAL-102 fixed this shape for `prep` by carrying that one field explicitly.
// This inverts the default instead: fields survive unless the form owns them.
// The tests below are therefore written against the RULE, not against the three
// names — a fourth field added to `Ingredient` tomorrow must survive too, and
// `carries a field this editor has never heard of` is the case that says so.

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

/**
 * A sold-by-weight row a shopper has already chosen a product and a weight for.
 * This is exactly what `saveChosenIngredient` writes: all four fields together.
 */
const deliTurkey = (): Ingredient => ({
  ingredientName: 'Turkey Breast',
  qty: 1,
  unit: 'lb',
  measure: '1',
  searchTerm: 'H-E-B Deli Oven Roasted Turkey Breast',
  productQty: 1,
  purchaseWeight: 1.5,
  weightStep: 0.25,
  dropdown: { type: 'preference', selectedText: 'Thin sliced', selectedValue: 'thin' },
});

const plainSalt = (): Ingredient => ({
  ingredientName: 'Salt',
  qty: 1,
  unit: 'qty',
  measure: null,
  searchTerm: null,
  productQty: 1,
});

function mount(ingredients: Ingredient[]) {
  const onChange = jest.fn();
  const view = render(<IngredientEditor ingredients={ingredients} onChange={onChange} />);
  /** The last array the editor emitted — i.e. what a save would persist. */
  const emitted = (): Ingredient[] => onChange.mock.calls[onChange.mock.calls.length - 1][0];
  return { ...view, onChange, emitted };
}

describe('the chosen weight survives an edit somewhere else', () => {
  it('survives a DIFFERENT row being renamed', () => {
    // The exact shape of the bug: every keystroke rewrites the whole array, so
    // the row that loses its weight is not the row being edited.
    const { getAllByPlaceholderText, emitted } = mount([plainSalt(), deliTurkey()]);
    fireEvent.changeText(getAllByPlaceholderText('Ingredient name')[0], 'Sea salt');

    expect(emitted()[0].ingredientName).toBe('Sea salt');
    expect(emitted()[1].purchaseWeight).toBe(1.5);
    expect(emitted()[1].weightStep).toBe(0.25);
    expect(emitted()[1].dropdown).toEqual({ type: 'preference', selectedText: 'Thin sliced', selectedValue: 'thin' });
  });

  it('survives its own amount being corrected', () => {
    const { getAllByPlaceholderText, emitted } = mount([deliTurkey()]);
    fireEvent.changeText(getAllByPlaceholderText('amt')[0], '2');

    expect(emitted()[0].measure).toBe('2');
    expect(emitted()[0].purchaseWeight).toBe(1.5);
    expect(emitted()[0].weightStep).toBe(0.25);
  });

  it('survives a unit change, which rebuilds the row down the other branch', () => {
    // `ownedFields` has two returns — countable and measured. A field preserved
    // on only one of them dies the moment someone picks "qty".
    const { getAllByText, getByText, emitted } = mount([deliTurkey()]);
    fireEvent.press(getAllByText('lb')[0]);
    fireEvent.press(getByText('qty'));

    expect(emitted()[0].unit).toBe('qty');
    expect(emitted()[0].purchaseWeight).toBe(1.5);
    expect(emitted()[0].weightStep).toBe(0.25);
  });

  it('survives a row being deleted from under it', () => {
    // The mock above renders each icon as its name, so this is the trash button
    // on the FIRST row — the deli row is the survivor.
    const { getAllByText, emitted } = mount([plainSalt(), deliTurkey()]);
    fireEvent.press(getAllByText('trash-outline')[0]);

    expect(emitted()).toHaveLength(1);
    expect(emitted()[0].purchaseWeight).toBe(1.5);
  });

  it('carries a field this editor has never heard of', () => {
    // The rule, not the three names. `fromFormIng` preserves by default now, so
    // a field added to `Ingredient` later survives without anyone remembering
    // to come back here — which is the failure this ticket is an instance of.
    const exotic = { ...deliTurkey(), someFutureField: 'keep me' } as unknown as Ingredient;
    const { getAllByPlaceholderText, emitted } = mount([exotic]);
    fireEvent.changeText(getAllByPlaceholderText('amt')[0], '3');

    expect((emitted()[0] as any).someFutureField).toBe('keep me');
  });
});

describe('but the chosen product\'s fields do not outlive the chosen product', () => {
  it('drops them when the row is renamed, which unchooses the product', () => {
    // Renaming already clears `searchTerm` — the row goes back to being
    // unchosen. A remembered weight left behind would be applied to whatever
    // product is chosen NEXT, swapping one over/under-add for another. These
    // three are written by `saveChosenIngredient` in the same breath as
    // `searchTerm`, so they end with it.
    const { getAllByPlaceholderText, emitted } = mount([deliTurkey()]);
    fireEvent.changeText(getAllByPlaceholderText('Ingredient name')[0], 'Ham');

    expect(emitted()[0].searchTerm).toBeNull();
    expect('purchaseWeight' in emitted()[0]).toBe(false);
    expect('weightStep' in emitted()[0]).toBe(false);
    expect('dropdown' in emitted()[0]).toBe(false);
  });

  it('leaves no null behind when it drops them', () => {
    // Absent, not null — the same additivity rule `prep` follows. A row that is
    // written back with three explicit nulls is not the row that was loaded.
    const { getAllByPlaceholderText, emitted } = mount([deliTurkey()]);
    fireEvent.changeText(getAllByPlaceholderText('Ingredient name')[0], 'Ham');

    const json = JSON.stringify(emitted()[0]);
    expect(json).not.toContain('purchaseWeight');
    expect(json).not.toContain('weightStep');
    expect(json).not.toContain('dropdown');
  });

  it('keeps the recipe amount, which is not a product choice', () => {
    // The line either side of the rule: `measure`/`unit` describe what the
    // recipe asks for and survive unchoosing, exactly as `prep` does.
    const { getAllByPlaceholderText, emitted } = mount([deliTurkey()]);
    fireEvent.changeText(getAllByPlaceholderText('Ingredient name')[0], 'Ham');

    expect(emitted()[0].measure).toBe('1');
    expect(emitted()[0].unit).toBe('lb');
  });
});

describe('a row the editor created has nothing to preserve', () => {
  it('carries none of the product fields', () => {
    const { getByText, emitted } = mount([plainSalt()]);
    fireEvent.press(getByText('Add measurement'));

    const fresh = emitted()[1];
    expect('purchaseWeight' in fresh).toBe(false);
    expect('weightStep' in fresh).toBe(false);
    expect('dropdown' in fresh).toBe(false);
    expect(fresh.searchTerm).toBeNull();
  });
});
