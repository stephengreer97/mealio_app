// How a creator reaches the draft review queue (MEAL-89).
//
// This is where the ticket's revised design actually lives, so it is what this
// file asserts:
//
//   • **Notification tap → the queue, directly.** They tapped the thing that
//     said "2 recipes ready"; the intent is unambiguous.
//   • **Every other entry → a card and a badge, and nothing else.** Opening the
//     app, or the Creator tab, never takes anyone into a review flow.
//   • **Nothing blocks.** The queue is rendered inside the tab rather than as a
//     Modal over the app, so the tab bar stays and leaving costs one touch —
//     including for a creator who arrived from a notification and changed their
//     mind.

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (props: any) => RealReact.createElement(RealView, { testID: 'mock-image', ...props }) };
});

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  const icon = (props: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, props.name);
  return { Feather: icon, Ionicons: icon };
});

jest.mock('react-native-safe-area-context', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return {
    SafeAreaProvider: (props: any) => RealReact.createElement(RealView, props, props.children),
    SafeAreaView: (props: any) => RealReact.createElement(RealView, props, props.children),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});

jest.mock('react-native-keyboard-aware-scroll-view', () => {
  const { ScrollView } = jest.requireActual('react-native');
  return { KeyboardAwareScrollView: ScrollView };
});

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

const mockGetMe = jest.fn();
const mockList = jest.fn();
jest.mock('../../src/lib/api', () => ({
  creators: { getMe: (...a: unknown[]) => mockGetMe(...a) },
  creatorDrafts: {
    list: (...a: unknown[]) => mockList(...a),
    decide: jest.fn(),
    edit: jest.fn(),
    count: jest.fn(async () => ({ waiting: 0 })),
  },
}));

const mockDraftsCtx = { waiting: 0, refresh: jest.fn(), setWaiting: jest.fn() };
jest.mock('../../src/context/CreatorDraftsContext', () => ({
  useCreatorDrafts: () => mockDraftsCtx,
}));

// PushOptInCard reaches the notification stack on mount and is not what is
// under test; it is self-hiding in the app and rendered as nothing here.
jest.mock('../../src/components/PushOptInCard', () => () => null);
jest.mock('../../src/components/MealDetailSheet', () => () => null);
jest.mock('../../src/components/PublishedLinkSheet', () => () => null);
jest.mock('../../src/components/PhotoPicker', () => () => null);

import CreatorPortalScreen from '../../src/screens/creator/CreatorPortalScreen';

/** One queued draft in the shape the server sends, enough for the queue to render it. */
function queuedDraft(id: string) {
  return {
    id,
    sourceUrl: 'https://chefsarah.test/guacamole',
    draft: {
      name: 'Best Guacamole', ingredients: [], recipe: null,
      source: 'https://chefsarah.test/guacamole', story: null, photoUrl: null,
      difficulty: null, tags: [], serves: null,
    },
    summary: { total: 1, verified: 1, needALook: 0 },
    review: {
      summaryText: '1 of 1 field verified.',
      notices: {
        name: null, recipe: null, story: null, photoUrl: null,
        difficulty: null, tags: null, serves: null, ingredients: [],
      },
    },
  };
}

async function mount(params?: { openQueue?: boolean; draftId?: string }) {
  const setParams = jest.fn();
  const view = render(<CreatorPortalScreen route={{ params }} navigation={{ setParams }} />);
  await act(async () => {});
  return { ...view, setParams };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDraftsCtx.waiting = 0;
  mockGetMe.mockResolvedValue({
    creator: { id: 'c1', displayName: 'Chef Sarah', handle: 'sarah' },
    meals: [],
    stats: { followers: 0, savesAnnual: 0, savesAll: 0, totalCreatorAnnualSaves: 0, annualPct: 0, sharePercent: 0 },
  });
  mockList.mockResolvedValue({ drafts: [], totals: { waiting: 0, flagged: 0 } });
});

describe('opening the app normally', () => {
  it('lands on the portal, not in a review flow', async () => {
    // The rule the whole revised design turns on: a creator who opened the app
    // to add a meal to their cart is not routed anywhere by having drafts.
    mockDraftsCtx.waiting = 3;

    const { queryByTestId, getByTestId } = await mount();

    expect(queryByTestId('creator-review-queue')).toBeNull();
    expect(getByTestId('open-draft-queue')).toBeTruthy();
  });

  it('offers the count as a card they can ignore', async () => {
    // The count, not a dot — "3" and "1" are different sizes of job.
    mockDraftsCtx.waiting = 3;
    const { getByText } = await mount();
    expect(getByText('3 recipes are ready for you')).toBeTruthy();
  });

  it('says nothing at all when the queue is empty', async () => {
    // The portal does not grow a box to tell a creator there is nothing to do.
    mockDraftsCtx.waiting = 0;
    const { queryByTestId } = await mount();
    expect(queryByTestId('open-draft-queue')).toBeNull();
  });

  it('opens the queue when they choose to', async () => {
    mockDraftsCtx.waiting = 1;
    mockList.mockResolvedValue({ drafts: [], totals: { waiting: 0, flagged: 0 } });

    const { getByTestId } = await mount();
    fireEvent.press(getByTestId('open-draft-queue'));
    await act(async () => {});

    expect(mockList).toHaveBeenCalled();
  });
});

describe('arriving from a notification', () => {
  it('opens the queue directly', async () => {
    // They tapped "2 recipes ready". Landing on the portal and making them find
    // it again is the version of this that wastes the tap.
    mockDraftsCtx.waiting = 2;

    const { queryByTestId } = await mount({ openQueue: true, draftId: 'd1' });

    expect(queryByTestId('open-draft-queue')).toBeNull();
    expect(mockList).toHaveBeenCalled();
  });

  it('hands the queue the recipe the tap was about', async () => {
    // `draftId` was threaded from the push payload through `push.ts:327` and
    // `MainTabsParamList` and then never read — `openQueue` was the only param
    // this screen looked at. A notification saying "Best Guacamole is ready"
    // therefore landed on whatever the persisted cursor pointed at, which on a
    // queue of ten is usually the wrong recipe and always looks like the right
    // one.
    mockDraftsCtx.waiting = 3;
    mockList.mockResolvedValue({
      waiting: 3,
      drafts: ['d1', 'd2', 'd3'].map(queuedDraft),
      totals: { waiting: 3, showing: 3, flagged: 0 },
    });

    const { getByTestId } = await mount({ openQueue: true, draftId: 'd3' });

    expect(getByTestId('queue-position').props.children.join('')).toBe('3 of 3');
  });

  it('opens on the front of the queue when the notification named nothing', async () => {
    // The ordinary path — the portal card, and a push that just says how many
    // are waiting — must not be changed by the one that names a recipe.
    mockDraftsCtx.waiting = 3;
    mockList.mockResolvedValue({
      waiting: 3,
      drafts: ['d1', 'd2', 'd3'].map(queuedDraft),
      totals: { waiting: 3, showing: 3, flagged: 0 },
    });

    const { getByTestId } = await mount({ openQueue: true });

    expect(getByTestId('queue-position').props.children.join('')).toBe('1 of 3');
  });

  it('consumes the param, so the same notification can open it again', async () => {
    // React Navigation hands over fresh params on a second tap, but the values
    // are identical — without clearing, a creator who opened the queue, closed
    // it, and tapped that notification again would land on the portal with
    // nothing happening.
    const { setParams } = await mount({ openQueue: true, draftId: 'd1' });
    expect(setParams).toHaveBeenCalledWith({ openQueue: false, draftId: undefined });
  });

  it('leaves them a way straight back out', async () => {
    // Rendered inside the tab rather than as a Modal, so the tab bar is still
    // there and Discover is one touch away the whole time. A creator who tapped
    // by reflex while meaning to shop must not have to decide a recipe to
    // escape.
    mockDraftsCtx.waiting = 1;
    mockList.mockResolvedValue({
      drafts: [{
        id: 'd1',
        sourceUrl: 'https://chefsarah.test/guacamole',
        draft: {
          name: 'Best Guacamole', ingredients: [], recipe: null,
          source: 'https://chefsarah.test/guacamole', story: null, photoUrl: null,
          difficulty: null, tags: [], serves: null,
        },
        summary: { total: 1, verified: 1, needALook: 0 },
        review: {
          summaryText: '1 of 1 field verified.',
          notices: {
            name: null, recipe: null, story: null, photoUrl: null,
            difficulty: null, tags: null, serves: null, ingredients: [],
          },
        },
      }],
      totals: { waiting: 1, flagged: 0 },
    });

    const { getByLabelText, queryByTestId } = await mount({ openQueue: true });
    fireEvent.press(getByLabelText('Back to your portal'));
    await act(async () => {});

    expect(queryByTestId('open-draft-queue')).toBeTruthy();
  });
});
