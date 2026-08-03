// The publish form's tag picker (the mobile half of the tag cap fix).
//
// The screen used to let a creator select as many tags as they liked, and
// `POST /api/creator/meals` now REFUSES an over-cap list rather than keeping the
// first three — so an uncapped picker turns Save Meal into an error message
// about a rule the form never mentioned.
//
// Every assertion here is on the selection the picker actually produces, held in
// a controlled harness exactly as `CreatorPortalScreen` holds it, rather than on
// whether `onChange` fired. "Called with four tags" and "ended up with four
// tags" are the same sentence right up until the component filters its own
// input, and it is the second one the server cares about.

import React, { useState } from 'react';
import { Text } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';
import TagPicker from '../../src/components/TagPicker';
import { MAX_MEAL_TAGS } from '../../src/constants/tags';

const TAGS = ['Mexican', 'No Cook', 'Vegan', 'Healthy', 'Snack'];

/** The picker as the screen wires it: selection and search are the caller's. */
function Harness({ initial = [] as string[] }) {
  const [selected, setSelected] = useState<string[]>(initial);
  const [search, setSearch] = useState('');
  return (
    <>
      <TagPicker
        selected={selected}
        onChange={setSelected}
        search={search}
        onSearchChange={setSearch}
        tags={TAGS}
      />
      {/* What the form would post. */}
      <SelectionProbe selected={selected} />
    </>
  );
}

function SelectionProbe({ selected }: { selected: string[] }) {
  // Prefixed so the probe's own text can never be mistaken for a tag chip by a
  // text query — the picker and the probe render the same words otherwise.
  return <Text testID="selection">{`chosen:${selected.join('|')}`}</Text>;
}

function selection(getByTestId: (id: string) => { props: { children: string } }): string[] {
  const value = String(getByTestId('selection').props.children).replace('chosen:', '');
  return value ? value.split('|') : [];
}

describe('TagPicker — the cap', () => {
  it('the cap is three, the number the server publishes', () => {
    expect(MAX_MEAL_TAGS).toBe(3);
  });

  it('takes tags up to the cap', () => {
    const { getByText, getByTestId } = render(<Harness />);

    fireEvent.press(getByText('Mexican'));
    fireEvent.press(getByText('No Cook'));
    fireEvent.press(getByText('Vegan'));

    expect(selection(getByTestId as never)).toEqual(['Mexican', 'No Cook', 'Vegan']);
  });

  it('refuses a fourth — the selection does not grow', () => {
    const { getByText, getByTestId } = render(<Harness initial={['Mexican', 'No Cook', 'Vegan']} />);

    fireEvent.press(getByText('Healthy'));

    expect(selection(getByTestId as never)).toEqual(['Mexican', 'No Cook', 'Vegan']);
  });

  it('marks the tags it will not take as disabled, and leaves the chosen ones live', () => {
    const { getByRole } = render(<Harness initial={['Mexican', 'No Cook', 'Vegan']} />);

    // Faded and inert rather than removed: which tags exist must not change as
    // you pick, or the list reflows under the thumb mid-tap.
    expect(getByRole('button', { name: 'Healthy' }).props.accessibilityState.disabled).toBe(true);
    // A chosen tag stays pressable, because deselecting is the way back.
    expect(getByRole('button', { name: 'Mexican' }).props.accessibilityState.disabled).toBe(false);
  });

  it('deselecting makes room again — a cap, not a freeze', () => {
    const { getByText, getByTestId } = render(<Harness initial={['Mexican', 'No Cook', 'Vegan']} />);

    fireEvent.press(getByText('No Cook'));
    fireEvent.press(getByText('Healthy'));

    expect(selection(getByTestId as never)).toEqual(['Mexican', 'Vegan', 'Healthy']);
  });
});

describe('TagPicker — saying what the limit is', () => {
  it('shows the count against the cap before it is reached', () => {
    const { getByTestId } = render(<Harness initial={['Mexican']} />);
    expect(getByTestId('tag-picker-count').props.children).toBe('1 of 3 chosen');
  });

  it('tells a creator how many to drop when a meal arrives over the cap', () => {
    // An edit opens on whatever the meal carries, and meals published before the
    // cap was enforced carry more than it. Refusing to say how many is how Save
    // Meal becomes a surprise 400.
    const { getByTestId } = render(
      <Harness initial={['Mexican', 'No Cook', 'Vegan', 'Healthy', 'Snack']} />,
    );

    expect(getByTestId('tag-picker-count').props.children).toBe(
      'That is 5 tags. A meal takes at most 3 — deselect 2.',
    );
  });

  it('stops asking once they are back at the cap', () => {
    const { getByText, getByTestId } = render(
      <Harness initial={['Mexican', 'No Cook', 'Vegan', 'Healthy']} />,
    );

    fireEvent.press(getByText('Healthy'));

    expect(getByTestId('tag-picker-count').props.children).toBe('3 of 3 chosen');
  });
});

describe('TagPicker — search', () => {
  it('narrows the list without losing what is already chosen', () => {
    const { getByLabelText, getByText, queryByText, getByTestId } = render(
      <Harness initial={['Mexican']} />,
    );

    fireEvent.changeText(getByLabelText('Search tags'), 'veg');

    expect(getByText('Vegan')).toBeTruthy();
    expect(queryByText('Mexican')).toBeNull();
    // Filtered out of view, still selected — the picker filters what is shown,
    // never what is held.
    expect(selection(getByTestId as never)).toEqual(['Mexican']);
  });
});
