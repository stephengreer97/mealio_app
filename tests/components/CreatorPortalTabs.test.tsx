// The Creator tab as three sections, the web portal's split (Meals / Drafts /
// Settings).
//
// The pieces are tested on their own elsewhere. This file holds down the join:
// that the tabs exist and switch, that Drafts carries the waiting count, that
// Drafts hosts the queue, and that Settings renders the profile and the sync
// section fed the creator the screen loaded. A component that works and is
// never rendered is the failure mode this exists to catch.

import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';

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

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn(async () => ({ type: 'dismiss' })) }));
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ status: 'denied' })),
  launchImageLibraryAsync: jest.fn(),
  MediaTypeOptions: { Images: 'Images' },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

const mockDraftsCtx = { waiting: 0, refresh: jest.fn(async () => {}), setWaiting: jest.fn() };
jest.mock('../../src/context/CreatorDraftsContext', () => ({
  useCreatorDrafts: () => mockDraftsCtx,
}));

jest.mock('../../src/components/MealDetailSheet', () => () => null);
jest.mock('../../src/components/PublishedLinkSheet', () => () => null);
jest.mock('../../src/components/PushOptInCard', () => () => null);
jest.mock('../../src/components/PhotoPicker', () => () => null);

jest.mock('../../src/lib/api', () => ({
  creators: {
    getMe: jest.fn(),
    updateProfile: jest.fn(async () => ({ ok: true })),
    setPrimarySource: jest.fn(async () => ({ ok: true })),
    checkWebsite: jest.fn(),
    youtube: { status: jest.fn(), setAppendOptIn: jest.fn(), disconnect: jest.fn() },
    connections: { status: jest.fn(), disconnect: jest.fn(), start: jest.fn(), complete: jest.fn() },
    sync: { catalog: jest.fn(), start: jest.fn(), read: jest.fn(), advance: jest.fn() },
    creatorMeals: { create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  },
  creatorDrafts: {
    list: jest.fn(async () => ({ drafts: [], waiting: 0, totals: { waiting: 0, flagged: 0 } })),
    decide: jest.fn(),
    edit: jest.fn(),
    count: jest.fn(async () => ({ waiting: 0 })),
  },
  images: { upload: jest.fn() },
}));

import CreatorPortalScreen from '../../src/screens/creator/CreatorPortalScreen';
import { creators as creatorsApi, creatorDrafts } from '../../src/lib/api';

const api = creatorsApi as any;

const CREATOR = {
  id: 'c1',
  displayName: 'Sarah',
  bio: 'I cook.',
  handle: 'sarah',
  socialHandle: '@chefsarah',
  websiteUrl: 'https://chefsarah.test/',
  feedUrl: 'https://chefsarah.test/feed/',
  youtubeUrl: null,
  instagramUrl: null,
  tiktokUrl: null,
  primarySource: 'website',
  importOptIn: true,
};

const MEAL = { id: 'm1', name: 'Lemon Chicken', ingredients: [], tags: [], trendingScore: 42 };
const STATS = { followers: 7, savesAnnual: 3, savesAll: 9, totalCreatorAnnualSaves: 100, annualPct: 3, sharePercent: 3 };

beforeEach(() => {
  jest.clearAllMocks();
  mockDraftsCtx.waiting = 0;
  api.getMe.mockResolvedValue({ creator: CREATOR, meals: [MEAL], stats: STATS });
  api.sync.catalog.mockResolvedValue({ ok: true, source: 'website', entries: [], truncated: false });
});

async function mount() {
  const r = render(<CreatorPortalScreen />);
  await r.findByText('Lemon Chicken');
  return r;
}

describe('the three tabs', () => {
  it('opens on Meals, with the meals, stats and earnings, and nothing from the other two', async () => {
    const r = await mount();
    expect(r.getByTestId('tab-meals').props.accessibilityState).toEqual({ selected: true });
    expect(r.getByText('Published Meals (1)')).toBeTruthy();
    expect(r.getByText('Followers')).toBeTruthy();
    expect(r.getByText('How earnings work')).toBeTruthy();
    expect(r.queryByTestId('sync-source-section')).toBeNull();
    expect(r.queryByTestId('profile-card')).toBeNull();
    // The queue is not read until Drafts is opened.
    expect(creatorDrafts.list).not.toHaveBeenCalled();
  });

  it('switches to Settings: the profile, then the sync section fed the loaded row', async () => {
    const r = await mount();
    fireEvent.press(r.getByTestId('tab-settings'));

    expect(await r.findByTestId('profile-card')).toBeTruthy();
    expect(r.getByTestId('sync-source-section')).toBeTruthy();
    expect(r.getByTestId('tab-settings').props.accessibilityState).toEqual({ selected: true });
    expect(r.getByTestId('referral-link')).toBeTruthy();
    expect(r.getByTestId('website-input').props.value).toBe('https://chefsarah.test/');
    expect(r.getByTestId('source-option-website').props.accessibilityState.selected).toBe(true);
    // Meals is out of sight.
    expect(r.queryByText('Published Meals (1)')).toBeNull();
    // And opening it wrote nothing.
    expect(api.setPrimarySource).not.toHaveBeenCalled();
  });

  it('switches to Drafts, which hosts the queue, and back', async () => {
    const r = await mount();
    fireEvent.press(r.getByTestId('tab-drafts'));
    expect(await r.findByTestId('creator-queue-empty')).toBeTruthy();
    expect(r.getByText('Drafts to review')).toBeTruthy();
    expect(creatorDrafts.list).toHaveBeenCalled();
    // The tab bar is the way back; the queue draws no button of its own for it.
    expect(r.queryByText('Back to your portal')).toBeNull();

    fireEvent.press(r.getByTestId('tab-meals'));
    expect(r.getByText('Published Meals (1)')).toBeTruthy();
    expect(r.queryByTestId('creator-queue-empty')).toBeNull();
  });

  it('keeps a tab’s state when switching away and back', async () => {
    const r = await mount();
    fireEvent.press(r.getByTestId('tab-settings'));
    fireEvent.changeText(await r.findByTestId('website-input'), 'half-typed.test');
    fireEvent.press(r.getByTestId('tab-meals'));
    fireEvent.press(r.getByTestId('tab-settings'));
    expect(r.getByTestId('website-input').props.value).toBe('half-typed.test');
  });
});

describe('the drafts count', () => {
  it('sits on the Drafts tab as a number, and on the Meals tab as a way in', async () => {
    mockDraftsCtx.waiting = 4;
    const r = await mount();
    expect(within(r.getByTestId('drafts-tab-badge')).getByText('4')).toBeTruthy();
    fireEvent.press(r.getByText('Review drafts'));
    await waitFor(() => expect(r.getByTestId('tab-drafts').props.accessibilityState).toEqual({ selected: true }));
  });

  it('is not drawn at all when nothing is waiting', async () => {
    const r = await mount();
    expect(r.queryByTestId('drafts-tab-badge')).toBeNull();
    expect(r.queryByTestId('open-draft-queue')).toBeNull();
  });
});

describe('the profile card', () => {
  it('saves bio and website through PATCH /api/creator/me and shows the result', async () => {
    const r = await mount();
    fireEvent.press(r.getByTestId('tab-settings'));
    fireEvent.press(await r.findByTestId('edit-profile'));
    fireEvent.changeText(r.getByTestId('profile-bio'), 'New bio');
    fireEvent.press(r.getByTestId('save-profile'));

    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith({
      bio: 'New bio', socialHandle: '@chefsarah', handle: 'sarah',
    }));
    expect(await r.findByText('New bio')).toBeTruthy();
  });

  it('shows the route’s refusal and stays in the form', async () => {
    const { ApiError } = require('../../src/lib/authErrors');
    api.updateProfile.mockRejectedValue(new ApiError(409, 'That handle is already taken.', { error: 'That handle is already taken.' }));
    api.getMe.mockResolvedValue({ creator: { ...CREATOR, handle: null }, meals: [MEAL], stats: STATS });
    const r = await mount();
    fireEvent.press(r.getByTestId('tab-settings'));
    fireEvent.press(await r.findByTestId('edit-profile'));
    fireEvent.changeText(r.getByTestId('profile-handle'), 'Taken Name!');
    expect(r.getByTestId('profile-handle').props.value).toBe('takenname');
    await act(async () => { fireEvent.press(r.getByTestId('save-profile')); });
    expect(await r.findByTestId('profile-error')).toBeTruthy();
    expect(r.getByTestId('profile-editor')).toBeTruthy();
  });
});
