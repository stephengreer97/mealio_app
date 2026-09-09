// The Follow button has to say what the caller knows.
//
// `GET /api/creators/[id]` does not report whether YOU follow the creator, so
// the sheet takes its initial state from the `creator` prop -- and Discover now
// fills that in from the followed list it holds for the Following strip.
//
// The sheet stays mounted between opens, and the sync effect was keyed on the
// creator's id alone. So reopening the SAME creator kept the state the last open
// ended on: tapping someone in the "Creators You Follow" strip showed "Follow".
// That is the regression these hold, and it is invisible on a first open, which
// is the only case a test that renders once would cover.

import { act, render } from '@testing-library/react-native';

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (props: any) => RealReact.createElement(RealView, props) };
});

jest.mock('react-native-safe-area-context', () => {
  const RealReact = jest.requireActual('react');
  const { View: RealView } = jest.requireActual('react-native');
  return {
    SafeAreaView: ({ children, ...rest }: any) => RealReact.createElement(RealView, rest, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('../../src/components/MealDetailSheet', () => () => null);

jest.mock('../../src/lib/api', () => ({
  creators: {
    getById: jest.fn(async () => ({ creator: { id: 'c1', displayName: 'Sarah Lane' }, meals: [] })),
    follow: jest.fn(async () => {}),
    unfollow: jest.fn(async () => {}),
  },
  presetMeals: { getById: jest.fn(async () => ({})) },
}));

import CreatorProfileSheet from '../../src/components/CreatorProfileSheet';

const sarah = (isFollowing: boolean) => ({
  id: 'c1',
  displayName: 'Sarah Lane',
  photoUrl: null,
  followers: 12,
  isFollowing,
});

describe('the follow button when the sheet opens', () => {
  it('says Following when the caller knows you follow them', async () => {
    const view = render(
      <CreatorProfileSheet visible creator={sarah(true) as never} onClose={jest.fn()} isLoggedIn />,
    );
    // The sheet fetches the creator's meals on open; let that settle.
    await act(async () => {});
    view.getByText('Following ✓');
  });

  it('re-reads that on every open, not only when the creator changes', async () => {
    const view = render(
      <CreatorProfileSheet visible creator={sarah(false) as never} onClose={jest.fn()} isLoggedIn />,
    );
    await act(async () => {});
    view.getByText('Follow');

    // Closed, then reopened on the SAME creator, now known to be followed.
    await act(async () => {
      view.update(
        <CreatorProfileSheet visible={false} creator={sarah(false) as never} onClose={jest.fn()} isLoggedIn />,
      );
    });
    await act(async () => {
      view.update(
        <CreatorProfileSheet visible creator={sarah(true) as never} onClose={jest.fn()} isLoggedIn />,
      );
    });
    view.getByText('Following ✓');
  });
});
