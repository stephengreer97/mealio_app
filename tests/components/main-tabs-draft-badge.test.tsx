// The pending-draft count where a creator actually sees it (MEAL-89).
//
// `creator-draft-badge.test.tsx` covers the number: where it comes from, when
// it is re-read, and that a failed read does not zero it. It renders the
// provider around a `<Text>` probe and never mounts `MainTabs`, so the wiring
// between the two — and the two rules the tab bar itself is responsible for —
// went untested. Replacing `tabBarBadge` with `undefined` left the whole suite
// green.
//
// The two rules, both of which are about the badge and not about the count:
//
//   1. **`undefined`, never `0`.** React Navigation renders a `0` badge as a
//      visible zero, which reads as a broken counter rather than as nothing to
//      do.
//   2. **Capped at "99+".** A badge stops being a badge somewhere past three
//      digits; past that it is a number wearing a tab bar.
//
// And the third, which is the reason the tab exists at all: the count is on the
// Creator tab and nowhere else.

import React from 'react';
import { act, render } from '@testing-library/react-native';

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  const icon = (props: any) => RealReact.createElement(RealText, null, props.name);
  return { Ionicons: icon, Feather: icon };
});

jest.mock('react-native-safe-area-context', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const inset = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    SafeAreaProvider: (props: any) => RealReact.createElement(RealView, props, props.children),
    SafeAreaView: (props: any) => RealReact.createElement(RealView, props, props.children),
    SafeAreaInsetsContext: RealReact.createContext(inset),
    useSafeAreaInsets: () => inset,
    useSafeAreaFrame: () => frame,
    initialWindowMetrics: { insets: inset, frame },
  };
});

// The tab bar is what is under test; the screens behind it are not, and several
// of them reach the network, SecureStore and the notification stack on mount.
jest.mock('../../src/screens/discover/DiscoverScreen', () => () => null);
jest.mock('../../src/screens/mymeals/MyMealsScreen', () => () => null);
jest.mock('../../src/screens/account/AccountScreen', () => () => null);
jest.mock('../../src/screens/creator/CreatorPortalScreen', () => () => null);
jest.mock('../../src/screens/help/HelpScreen', () => () => null);
jest.mock('../../src/screens/admin/AdminScreen', () => () => null);
jest.mock('../../src/components/BroadcastBanner', () => () => null);

const mockAuth = { isCreator: true, isAdmin: false };
jest.mock('../../src/context/AuthContext', () => ({ useAuth: () => mockAuth }));

const mockDrafts = { waiting: 0 };
jest.mock('../../src/context/CreatorDraftsContext', () => ({
  useCreatorDrafts: () => mockDrafts,
}));

import { NavigationContainer } from '@react-navigation/native';
import MainTabs from '../../src/navigation/MainTabs';

async function mount() {
  const view = render(
    <NavigationContainer>
      <MainTabs />
    </NavigationContainer>,
  );
  await act(async () => {});
  return view;
}

/**
 * Every badge the tab bar is actually showing.
 *
 * React Navigation renders a `Badge` for every tab and hides the empty ones
 * with `visible: false`, so "is there a badge" is a question about that prop
 * and not about whether a node exists — querying by text would call a hidden
 * badge and a missing one the same thing, which is exactly the distinction the
 * `undefined`-not-`0` rule turns on.
 */
function shownBadges(view: ReturnType<typeof render>) {
  return view.UNSAFE_root.findAll((node) => {
    const type = node.type as any;
    if (typeof type === 'string') return false;
    return (type?.displayName ?? type?.name) === 'Badge' && node.props?.visible === true;
  });
}

function badgeText(view: ReturnType<typeof render>): string | null {
  const shown = shownBadges(view);
  return shown.length === 0 ? null : String(shown[0].props.children);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.isCreator = true;
  mockAuth.isAdmin = false;
  mockDrafts.waiting = 0;
});

describe('the count on the Creator tab', () => {
  it('shows the number waiting', async () => {
    // The COUNT, never a dot: "10" tells a creator to set an evening aside and
    // "1" tells them it is a two-minute job. A dot says the same to both.
    mockDrafts.waiting = 10;
    expect(badgeText(await mount())).toBe('10');
  });

  it('shows nothing at all at zero, rather than a "0"', async () => {
    // React Navigation renders a `0` badge as a visible zero, which reads as a
    // broken counter rather than as nothing to do — so the value has to be
    // `undefined` and not the falsy number.
    mockDrafts.waiting = 0;
    expect(badgeText(await mount())).toBeNull();
  });

  it('caps at 99+, because a badge stops being a badge past three digits', async () => {
    mockDrafts.waiting = 250;
    expect(badgeText(await mount())).toBe('99+');
  });

  it('still shows 99 exactly, so the cap is a cap and not an off-by-one', async () => {
    mockDrafts.waiting = 99;
    expect(badgeText(await mount())).toBe('99');
  });

  it('is not shown to a user who is not a creator — there is no tab to put it on', async () => {
    mockAuth.isCreator = false;
    mockDrafts.waiting = 4;

    const view = await mount();

    expect(view.queryByTestId('tab-creator')).toBeNull();
    expect(badgeText(view)).toBeNull();
  });

  it('is on the Creator tab and on no other', async () => {
    // A count of recipes waiting on this creator has nothing to say on
    // Discover, My Meals or Account, and a badge that leaked onto one of them
    // would be an interruption on a tab somebody opened to shop.
    mockDrafts.waiting = 3;
    const view = await mount();

    expect(shownBadges(view)).toHaveLength(1);
    expect(view.getByTestId('tab-creator')).toBeTruthy();
  });
});
