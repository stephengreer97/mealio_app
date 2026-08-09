// MEAL-102 — a preparation is shown, and is not erased by an unrelated save.
//
// The second half is the one that bites. `IngredientEditor.emit` runs the WHOLE
// list back through `fromFormIng` on every keystroke, rebuilding each Ingredient
// from a literal — so a field the form does not carry is not merely
// un-editable, it is DELETED, on every row, by correcting a typo somewhere else
// on the screen. That rebuilt array is what three writers persist:
//
//   • MealDetailSheet.handleSave       → PUT /api/meals/[id]
//   • CreatorPortalScreen              → POST/PUT /api/creator/meals
//   • CreatorReviewQueueScreen.saveEdit → creatorDrafts.edit
//
// The last is the worst: the draft review queue is the screen where a creator
// first SEES the preparation we extracted from their own recipe, and the same
// screen offers them an edit box. A field that survives display but dies on an
// unrelated save is worse than not having the field at all.

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

const dicedOnion = (): Ingredient => ({
  ingredientName: 'Onion',
  qty: 1,
  unit: 'qty',
  measure: '1',
  searchTerm: null,
  productQty: 1,
  prep: 'finely diced',
});

/** A row with nothing to say, to prove the field stays absent for it. */
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

describe('the editor shows a preparation it cannot edit', () => {
  it('renders the preparation the row arrived with', () => {
    const { getByText } = mount([dicedOnion()]);
    expect(getByText('finely diced')).toBeTruthy();
  });

  it('shows nothing for a row that has none', () => {
    const { queryByTestId } = mount([plainSalt()]);
    expect(queryByTestId('ingredient-prep-0')).toBeNull();
  });

  it('offers no way to type one', () => {
    // Deliberate: whether a creator gets their own box, or types it inline and
    // we split on the comma, is Stephen's call and is on his checklist. This
    // ticket renders what exists rather than inventing the input.
    const { UNSAFE_getAllByType } = mount([dicedOnion()]);
    const { TextInput } = require('react-native');
    // Name, measure — and no third box. The unit is a button, not an input.
    expect(UNSAFE_getAllByType(TextInput)).toHaveLength(2);
  });
});

describe('an unrelated edit does not erase the preparation', () => {
  it('keeps it when the row\'s own measure is corrected', () => {
    const { getAllByPlaceholderText, emitted } = mount([dicedOnion()]);
    fireEvent.changeText(getAllByPlaceholderText('1')[0], '2');
    expect(emitted()[0].prep).toBe('finely diced');
  });

  it('keeps it when the row\'s own NAME is corrected', () => {
    // Renaming clears `searchTerm`, because the chosen product no longer matches
    // the name. The preparation is not a product choice — "finely diced" is
    // still what the recipe asked for — so it stays.
    const { getAllByPlaceholderText, emitted } = mount([dicedOnion()]);
    fireEvent.changeText(getAllByPlaceholderText('Ingredient name')[0], 'Yellow onion');
    expect(emitted()[0].prep).toBe('finely diced');
    expect(emitted()[0].searchTerm).toBeNull();
  });

  it('keeps it on a row nobody touched, when a DIFFERENT row is edited', () => {
    // The exact shape of the bug: every keystroke rewrites the whole array.
    const { getAllByPlaceholderText, emitted } = mount([plainSalt(), dicedOnion()]);
    fireEvent.changeText(getAllByPlaceholderText('Ingredient name')[0], 'Sea salt');
    expect(emitted()[1].prep).toBe('finely diced');
    expect(emitted()[0].ingredientName).toBe('Sea salt');
  });

  it('keeps it across a unit change, which rebuilds the row down the other branch', () => {
    // `fromFormIng` has two returns — countable and measured — and a field added
    // to only one of them dies the moment a creator picks "cups".
    const { getAllByText, getByText, emitted } = mount([dicedOnion()]);
    fireEvent.press(getAllByText('qty')[0]);
    fireEvent.press(getByText('cups'));
    expect(emitted()[0].unit).toBe('cups');
    expect(emitted()[0].prep).toBe('finely diced');
  });

  it('adds no prep key to a row that never had one', () => {
    // The additive half: an edited row with no preparation must serialise the
    // way it did before the field existed, because this array is written back.
    const { getAllByPlaceholderText, emitted } = mount([plainSalt()]);
    fireEvent.changeText(getAllByPlaceholderText('Ingredient name')[0], 'Sea salt');
    expect('prep' in emitted()[0]).toBe(false);
    expect(JSON.stringify(emitted()[0])).not.toContain('prep');
  });

  it('adds no prep key to a row created from scratch', () => {
    const { getByText, emitted } = mount([plainSalt()]);
    fireEvent.press(getByText('Add measurement'));
    expect('prep' in emitted()[1]).toBe(false);
  });
});

describe('a preparation that is awkward text is still just text', () => {
  it('renders a preparation containing commas whole', () => {
    const prep = 'drained, rinsed and patted dry';
    const { getByText } = mount([{ ...dicedOnion(), prep }]);
    expect(getByText(prep)).toBeTruthy();
  });

  it('renders markup literally, and carries it through a save unchanged', () => {
    // React Native <Text> parses neither HTML nor markdown, so the contract is
    // that the string comes out exactly as it went in — nothing interpreted,
    // nothing stripped, and nothing that could reach a store query.
    const prep = '<b>finely</b> diced *and* salted';
    const { getByText, getAllByPlaceholderText, emitted } = mount([{ ...dicedOnion(), prep }]);
    expect(getByText(prep)).toBeTruthy();
    fireEvent.changeText(getAllByPlaceholderText('1')[0], '3');
    expect(emitted()[0].prep).toBe(prep);
    expect(emitted()[0].ingredientName).toBe('Onion');
    expect(emitted()[0].searchTerm).toBeNull();
  });
});
