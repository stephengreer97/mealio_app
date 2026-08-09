// Both creator settings, reached the way a creator reaches them (MEAL-94 / 78).
//
// The two cards are tested on their own elsewhere. What this file holds down is
// the join: that they are actually rendered by `CreatorPortalScreen`, fed the
// creator the screen loaded, and that a link save makes the screen re-read the
// row rather than leaving stale links and a stale polled sentence on screen.
//
// A component that works perfectly and is never rendered is the failure mode
// these exist to catch, and it is invisible to both of the other test files.

import { fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (props: any) => RealReact.createElement(RealView, { testID: 'mock-image', ...props }) };
});

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  const icon = (props: any) => RealReact.createElement(RealText, null, props.name);
  return { Ionicons: icon, Feather: icon, MaterialIcons: icon };
});

jest.mock('react-native-safe-area-context', () => {
  const RealReact = jest.requireActual('react');
  const { View: RealView } = jest.requireActual('react-native');
  return {
    SafeAreaView: ({ children, ...rest }: any) => RealReact.createElement(RealView, rest, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('react-native-keyboard-aware-scroll-view', () => {
  const { ScrollView } = jest.requireActual('react-native');
  return { KeyboardAwareScrollView: ScrollView };
});

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'dismiss' })) }));

// Since MEAL-89 the portal renders the review queue in place of itself, and the
// queue reads this context, which reaches AuthContext and a good deal of the
// app behind it. The links and YouTube cards are what is under test, so the
// context is stubbed the same way `creator-portal-queue-entry.test.tsx` stubs
// it. (This stub also used to be load-bearing for a second reason — AuthContext
// pulls `react-native-purchases`, whose ESM dist Jest could not parse. That is
// handled centrally now; see `__mocks__/react-native-purchases.js`. The
// isolation below is still wanted on its own merits.)
jest.mock('../../src/context/CreatorDraftsContext', () => ({
  useCreatorDrafts: () => ({ waiting: 0, refresh: jest.fn(), announce: jest.fn() }),
}));

jest.mock('../../src/components/MealDetailSheet', () => () => null);
jest.mock('../../src/components/PublishedLinkSheet', () => () => null);
jest.mock('../../src/components/PushOptInCard', () => () => null);
jest.mock('../../src/components/PhotoPicker', () => () => null);

jest.mock('../../src/lib/api', () => ({
  creators: {
    getMe: jest.fn(),
    updateLinks: jest.fn(async () => ({ ok: true, notices: [], importPaused: false })),
    youtube: {
      status: jest.fn(),
      setAppendOptIn: jest.fn(async (appendOptIn: boolean) => ({ ok: true, appendOptIn })),
      disconnect: jest.fn(async () => ({ ok: true })),
    },
    creatorMeals: { create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  },
  images: { upload: jest.fn() },
}));

import CreatorPortalScreen from '../../src/screens/creator/CreatorPortalScreen';
import { creators as creatorsApi } from '../../src/lib/api';

const getMe = creatorsApi.getMe as unknown as jest.Mock;
const updateLinks = creatorsApi.updateLinks as unknown as jest.Mock;
const ytStatus = creatorsApi.youtube.status as unknown as jest.Mock;

const CREATOR = {
  id: 'c1',
  displayName: 'Sarah',
  approvedAt: '2026-01-01',
  websiteUrl: 'https://chefsarah.test/',
  youtubeUrl: null,
  instagramUrl: null,
  tiktokUrl: null,
  primarySource: 'website',
  importOptIn: true,
};

const NO_CHANNEL = {
  hasChannel: false,
  connected: false,
  channel: null,
  brokenReason: null,
  canWriteDescriptions: false,
  appendOptIn: false,
};

beforeEach(() => {
  getMe.mockReset();
  updateLinks.mockReset();
  ytStatus.mockReset();
  getMe.mockResolvedValue({ creator: CREATOR, meals: [], stats: null });
  updateLinks.mockResolvedValue({ ok: true, notices: [], importPaused: false });
  ytStatus.mockResolvedValue(NO_CHANNEL);
});

describe('CreatorPortalScreen — the link editor is reachable and fed the loaded row', () => {
  it('shows the creator’s stored links and which one is being read', async () => {
    const r = render(<CreatorPortalScreen />);
    await r.findByText('Your links');
    expect(r.getByText('https://chefsarah.test/')).toBeTruthy();
    expect(r.getAllByText(/importing your recipes from your Website/i).length).toBeGreaterThan(0);
  });

  it('re-reads the row after a save, so the boxes show what was stored', async () => {
    // Links are normalised server-side. Without the refresh the screen would go
    // on showing what the creator typed and, worse, the polled sentence from
    // before a save that may have just paused the import.
    const r = render(<CreatorPortalScreen />);
    fireEvent.press(await r.findByText('Manage links'));

    fireEvent.changeText(r.getByPlaceholderText('youtube.com/@chefsarah'), 'youtube.com/@sarah');
    fireEvent.press(r.getByText('Save links'));

    await waitFor(() => expect(updateLinks).toHaveBeenCalled());
    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(2));
  });
});

describe('CreatorPortalScreen — the YouTube setting', () => {
  it('is nowhere on the screen for a creator with no channel', async () => {
    // The requirement, asserted from the outside: not merely off, not merely
    // disabled — absent. Anything else is a prompt to edit descriptions on a
    // channel that does not exist.
    const r = render(<CreatorPortalScreen />);
    await r.findByText('Your links');
    expect(r.queryByText(/Let Mealio add the Mealio link/i)).toBeNull();
    expect(r.queryByText('YOUTUBE')).toBeNull();
  });

  it('appears, off, once a channel exists', async () => {
    ytStatus.mockResolvedValue({
      hasChannel: true,
      connected: true,
      channel: { id: 'UC1', title: "Sarah's Kitchen" },
      brokenReason: null,
      canWriteDescriptions: true,
      appendOptIn: false,
    });

    const r = render(<CreatorPortalScreen />);
    const consent = await r.findByLabelText(/Let Mealio add the Mealio link/i);
    expect(consent.props.accessibilityState.checked).toBe(false);
    expect(r.getByText("Sarah's Kitchen")).toBeTruthy();
  });
});
