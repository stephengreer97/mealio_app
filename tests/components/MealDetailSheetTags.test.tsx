// The tag cap on the meal edit form.
//
// `MealDetailSheet`'s editor had no cap at all: a user could select nine tags
// and `PUT /api/meals/[id]` — which counts them now — would come back 400. It
// renders the shared `TagPicker` instead of a fourth hand-rolled copy, so what
// these assert is that the swap actually happened and carries the picker's
// behaviour: the cap, the count, and the sentence saying how many to drop.
//
// The grandfathering half is asserted here too. Personal meals written before
// the cap carry more than three tags, and this form opens on whatever the meal
// holds — so the picker must open *over* the cap rather than refusing to show
// it, and saving an untouched list must still go through.

import { fireEvent, render } from '@testing-library/react-native';

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (props: any) => RealReact.createElement(RealView, { testID: 'mock-image', ...props }) };
});

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return {
    Feather: (props: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, props.name),
    Ionicons: (props: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, props.name),
  };
});

jest.mock('react-native-keyboard-aware-scroll-view', () => {
  const { ScrollView } = jest.requireActual('react-native');
  return { KeyboardAwareScrollView: ScrollView };
});

jest.mock('react-native-safe-area-context', () => {
  const RealReact = jest.requireActual('react');
  const { View: RealView } = jest.requireActual('react-native');
  return {
    SafeAreaView: ({ children, ...rest }: any) => RealReact.createElement(RealView, rest, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('../../src/lib/api', () => ({
  meals: {
    update: jest.fn(async (_id: string, body: any) => ({ id: 'm1', ...body })),
    delete: jest.fn(),
    share: jest.fn(),
  },
  images: { upload: jest.fn() },
}));

import MealDetailSheet from '../../src/components/MealDetailSheet';
import Tag from '../../src/components/ui/Tag';
import { meals as mealsApi } from '../../src/lib/api';

const update = mealsApi.update as unknown as jest.Mock;

type Chip = { props: { label: string; disabled?: boolean; onPress: () => void } };

const meal = (tags: string[], serves?: string) => ({
  id: 'm1',
  name: 'Tacos',
  storeId: 'heb',
  store_id: 'heb',
  ingredients: [{ ingredientName: 'tortillas', qty: 1, productQty: 1, unit: 'qty', measure: null, searchTerm: null }],
  tags,
  serves,
  photoUrl: null,
});

/** Renders the sheet and puts it into edit mode, which is where the picker is. */
function openEditor(tags: string[], serves?: string) {
  const r = render(
    <MealDetailSheet
      visible
      mode="edit"
      meal={meal(tags, serves) as never}
      onClose={jest.fn()}
      onSave={jest.fn()}
    />,
  );
  fireEvent.press(r.getByText('Edit'));
  return r;
}

const chips = (r: { UNSAFE_getAllByType: (t: unknown) => Chip[] }): Chip[] => r.UNSAFE_getAllByType(Tag);
const chipFor = (r: { UNSAFE_getAllByType: (t: unknown) => Chip[] }, label: string): Chip =>
  chips(r).find((c) => c.props.label === label)!;

beforeEach(() => update.mockClear());

describe('MealDetailSheet — the edit form caps tags', () => {
  it('offers the picker, and stops at the cap', () => {
    const r = openEditor(['Mexican']);

    // Below the cap nothing is inert.
    expect(chipFor(r as never, 'Vegan').props.disabled).toBe(false);

    fireEvent.press(r.getByText('No Cook'));
    fireEvent.press(r.getByText('Vegan'));

    // Three chosen: the rest are faded and inert, which is what the form used
    // to have no notion of.
    expect(chipFor(r as never, 'Healthy').props.disabled).toBe(true);
    expect(chipFor(r as never, 'Mexican').props.disabled).toBe(false);
  });

  it('says how many to drop when the meal arrives over the cap', () => {
    // Written before `PUT /api/meals/[id]` counted tags. The route grandfathers
    // it, so this opens rather than refusing — and the picker says why the rest
    // of the chips are inert instead of leaving them unexplained.
    const r = openEditor(['Mexican', 'No Cook', 'Vegan', 'Healthy', 'Snack']);

    expect(r.getByTestId('tag-picker-count').props.children).toBe(
      'That is 5 tags. A meal takes at most 3. Deselect 2.',
    );
  });

  it('sends an untouched over-cap list back exactly as it arrived', async () => {
    // The route reads this to decide the save did not change the tags. Trimming
    // it here would throw away a choice somebody made without saying so.
    const legacy = ['Mexican', 'No Cook', 'Vegan', 'Healthy', 'Snack'];
    const r = openEditor(legacy);

    fireEvent.press(r.getByText('Save Changes'));

    await r.findByText('Edit');
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][1].tags).toEqual(legacy);
  });

  it('lets an over-cap list be brought back down, which is the way out', async () => {
    const r = openEditor(['Mexican', 'No Cook', 'Vegan', 'Healthy', 'Snack']);

    fireEvent.press(r.getByText('Snack'));
    fireEvent.press(r.getByText('Healthy'));

    expect(r.getByTestId('tag-picker-count').props.children).toBe('3 of 3 chosen');

    fireEvent.press(r.getByText('Save Changes'));
    await r.findByText('Edit');
    expect(update.mock.calls[0][1].tags).toEqual(['Mexican', 'No Cook', 'Vegan']);
  });

  it('gives a custom tag a chip, so a personal meal can be edited at all', async () => {
    // The web `my-meals` picker adds custom tags, and this form opens on them.
    // Rendering only the vocabulary left such a tag selected, invisible and
    // permanently counted against the cap.
    const r = openEditor(["Grandma's", 'Mexican', 'Vegan']);

    expect(chipFor(r as never, "Grandma's").props.disabled).toBe(false);
    fireEvent.press(r.getByText("Grandma's"));

    fireEvent.press(r.getByText('Save Changes'));
    await r.findByText('Edit');
    expect(update.mock.calls[0][1].tags).toEqual(['Mexican', 'Vegan']);
  });
});
