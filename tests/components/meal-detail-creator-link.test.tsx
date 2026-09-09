// The byline on an open meal opens the creator, the way it does on the website.
//
// The card names the creator and, since the face landed on it, shows them too --
// and tapping the name did nothing. Discover already had a creator profile sheet
// and two ways into it (the featured row, and a meal opened from inside a
// profile); the meal you are actually reading was not one of them.
//
// The distinction the tests below hold onto is creator vs author. `author` is a
// string copied off a recipe with nobody behind it, so it must stay plain text:
// a link that opens nothing is worse than no link.

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
  meals: { update: jest.fn(), delete: jest.fn(), share: jest.fn() },
  images: { upload: jest.fn() },
}));

import MealDetailSheet from '../../src/components/MealDetailSheet';
import type { PresetMeal } from '../../src/types';

const mealBy = (extra: Partial<PresetMeal>): PresetMeal => ({
  id: 'p1',
  name: 'Garlic butter shrimp',
  ingredients: [],
  ...extra,
});

describe('the byline on an open meal', () => {
  it('opens the creator it names', () => {
    const onCreatorPress = jest.fn();
    const { getByTestId } = render(
      <MealDetailSheet
        visible
        mode="view"
        meal={mealBy({ creatorId: 'c1', creatorName: 'Sarah Lane' })}
        onClose={jest.fn()}
        onCreatorPress={onCreatorPress}
      />,
    );
    fireEvent.press(getByTestId('meal-detail-creator'));
    expect(onCreatorPress).toHaveBeenCalledWith('c1');
  });

  it('stays plain text for an author, who has no profile to open', () => {
    const { queryByTestId, getByText } = render(
      <MealDetailSheet
        visible
        mode="view"
        meal={mealBy({ author: 'An old cookbook' })}
        onClose={jest.fn()}
        onCreatorPress={jest.fn()}
      />,
    );
    getByText('by An old cookbook');
    expect(queryByTestId('meal-detail-creator')).toBeNull();
  });

  it('stays plain text where the caller offers nowhere to go', () => {
    const { queryByTestId, getByText } = render(
      <MealDetailSheet
        visible
        mode="view"
        meal={mealBy({ creatorId: 'c1', creatorName: 'Sarah Lane' })}
        onClose={jest.fn()}
      />,
    );
    getByText('by Sarah Lane');
    expect(queryByTestId('meal-detail-creator')).toBeNull();
  });

  it('names the handle when there is one, and still opens the creator behind it', () => {
    const onCreatorPress = jest.fn();
    const { getByText, getByTestId } = render(
      <MealDetailSheet
        visible
        mode="view"
        meal={mealBy({ creatorId: 'c1', creatorName: 'Sarah Lane', creatorSocial: 'sarahcooks' })}
        onClose={jest.fn()}
        onCreatorPress={onCreatorPress}
      />,
    );
    getByText('by @sarahcooks');
    fireEvent.press(getByTestId('meal-detail-creator'));
    expect(onCreatorPress).toHaveBeenCalledWith('c1');
  });
});
