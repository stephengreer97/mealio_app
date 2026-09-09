// Whose meal is this, answered by a face.
//
// The card is half the screen wide. Its body already carries a two-line name, a
// byline, a saved-at line and sometimes a warning, so an avatar in that column
// would take about a fifth of the body's width away from the byline — the line
// most likely to wrap. It goes on the photo instead, which costs the text
// nothing, and the assertion that guards that decision is the last one here.

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (props: any) => RealReact.createElement(RealView, { testID: 'mock-image', ...props }) };
});

import MealCard from '../../src/components/MealCard';
import type { PresetMeal } from '../../src/types';

const meal: PresetMeal = {
  id: 'm1',
  name: 'Garlic butter shrimp',
  ingredients: [],
  photoUrl: 'https://img/meal.jpg',
};

describe('the creator face on a meal card', () => {
  it('shows the creator photo when there is one', () => {
    const { getByTestId } = render(
      <MealCard meal={meal} creatorName="Sarah Lane" creatorPhotoUrl="https://img/sarah.jpg" />,
    );
    const avatar = getByTestId('creator-avatar');
    const image = avatar.findByProps({ testID: 'mock-image' });
    expect(image.props.source).toEqual({ uri: 'https://img/sarah.jpg' });
  });

  it('falls back to the creator initial rather than an empty circle', () => {
    const { getByTestId, getByText } = render(<MealCard meal={meal} creatorName="Priya" />);
    getByTestId('creator-avatar');
    getByText('P');
  });

  it('takes the initial from the name, not the @ in front of a handle', () => {
    const { getByText } = render(<MealCard meal={meal} creatorName="@sarahcooks" />);
    getByText('S');
  });

  it('shows no face for an author-only meal, which has no creator behind it', () => {
    const { queryByTestId } = render(<MealCard meal={{ ...meal, author: 'An old cookbook' }} />);
    expect(queryByTestId('creator-avatar')).toBeNull();
  });

  it('is positioned over the photo rather than laid out in the body', () => {
    const { getByTestId } = render(
      <MealCard meal={meal} subtitle="Sarah Lane" creatorName="Sarah Lane" creatorPhotoUrl="https://img/sarah.jpg" />,
    );
    const style = Object.assign({}, ...[getByTestId('creator-avatar').props.style].flat());
    // Absolute, so it takes no width from the byline. If this becomes a laid-out
    // row in the body, the byline starts wrapping and this fails.
    expect(style.position).toBe('absolute');
  });

  it('opens the creator when the face is pressed', () => {
    const onCreatorPress = jest.fn();
    const { getByTestId } = render(
      <MealCard
        meal={meal}
        creatorName="Sarah Lane"
        creatorPhotoUrl="https://img/sarah.jpg"
        onCreatorPress={onCreatorPress}
      />,
    );
    fireEvent.press(getByTestId('creator-avatar'));
    expect(onCreatorPress).toHaveBeenCalledTimes(1);
  });

  it('opens the creator instead of the meal, not as well as it', () => {
    // The card is itself a Touchable. React Native gives the touch to the
    // innermost responder, which is what spares this the website's
    // stopPropagation -- but only while the face IS a Touchable of its own.
    const onCreatorPress = jest.fn();
    const onPress = jest.fn();
    const { getByTestId } = render(
      <MealCard meal={meal} creatorName="Sarah Lane" onPress={onPress} onCreatorPress={onCreatorPress} />,
    );
    fireEvent.press(getByTestId('creator-avatar'));
    expect(onCreatorPress).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('is not pressable where the caller offers nowhere to go', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <MealCard meal={meal} creatorName="Sarah Lane" onPress={onPress} />,
    );
    expect(getByTestId('creator-avatar').props.accessibilityRole).toBeUndefined();
  });
});
