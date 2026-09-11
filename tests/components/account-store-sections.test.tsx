// What the Account screen says about grocery stores.
//
// Three rules, all from Stephen on 2026-09-11:
//
//   1. One place to sign out of stores, and it takes everything with it,
//      including the Kroger account link. There used to be two controls: this
//      button and a Disconnect button inside the Kroger card.
//   2. It does not say which stores you are connected to. The old card listed
//      the ones the prewarm had confirmed this session, under a caveat
//      admitting the list was a floor rather than the truth.
//   3. The Kroger card appears only for accounts with a meal saved at one of
//      its banners. For everyone else it is instructions for an account link
//      they have no use for.
//
// Rule 3 is the one with logic behind it, so it is tested from both sides.

import { render, waitFor } from '@testing-library/react-native';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

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

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (props: any) => RealReact.createElement(RealView, props) };
});

jest.mock('react-native-keyboard-aware-scroll-view', () => {
  const { ScrollView } = jest.requireActual('react-native');
  return { KeyboardAwareScrollView: ScrollView };
});

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void) => {
    const RealReact = jest.requireActual('react');
    RealReact.useEffect(() => cb(), []);
  },
  useNavigation: () => ({ getParent: () => null, navigate: jest.fn(), addListener: () => () => {} }),
  useRoute: () => ({ params: {} }),
}));

// The dev-only probes on this screen pull in react-native-webview, whose native
// module is not present under jest. None of them is what this file is about.
jest.mock('../../src/components/CartClearProbe', () => () => null);
jest.mock('../../src/components/StorefrontCaptureProbe', () => () => null);
jest.mock('../../src/components/Meal17Probe', () => () => null);
jest.mock('../../src/components/NotificationSettingsSheet', () => () => null);
jest.mock('react-native-webview', () => ({ WebView: () => null }));

jest.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.co', tier: 'free', firstName: 'Sam', lastName: 'Lee' },
    logout: jest.fn(),
    refreshUser: jest.fn(),
    isCreator: false,
  }),
}));

jest.mock('react-native-purchases', () => ({ __esModule: true, default: {} }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(), openAuthSessionAsync: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('../../src/lib/purchases', () => ({
  getAllOfferings: jest.fn(async () => []),
  purchasePackage: jest.fn(),
  restorePurchases: jest.fn(),
  getActiveSubscriptionStore: jest.fn(async () => null),
  getEntitlementDetails: jest.fn(async () => null),
  getManagementURL: jest.fn(async () => null),
  onEntitlementChange: jest.fn(() => () => {}),
  ENTITLEMENT_ID: 'full_access',
}));

jest.mock('../../src/lib/push', () => ({
  getPushStatus: jest.fn(async () => 'unsupported'),
  registerForPush: jest.fn(),
  supportsRemotePush: () => false,
}));

jest.mock('../../src/lib/api', () => ({
  meals: {
    list: jest.fn(async () => [] as any[]),
    listDeleted: jest.fn(async () => []),
    restore: jest.fn(),
    permanentDelete: jest.fn(),
  },
  account: { changePassword: jest.fn() },
  creators: { getMe: jest.fn(async () => ({ creator: null, application: null })), updateMe: jest.fn() },
  kroger: { status: jest.fn(async () => ({ connected: false, locations: {} })), disconnect: jest.fn() },
  images: { upload: jest.fn() },
}));

import AccountScreen from '../../src/screens/account/AccountScreen';
import { meals as mealsApi } from '../../src/lib/api';

const listMeals = mealsApi.list as unknown as jest.Mock;

const krogerMeal = { id: 'm1', name: 'Chili', storeId: 'ralphs', ingredients: [] };
const hebMeal = { id: 'm2', name: 'Tacos', storeId: 'heb', ingredients: [] };

beforeEach(() => {
  jest.clearAllMocks();
  listMeals.mockResolvedValue([]);
});

describe('the Kroger card', () => {
  it('is hidden for an account with no meal at one of its banners', async () => {
    listMeals.mockResolvedValue([hebMeal] as any);
    const view = render(<AccountScreen />);
    await waitFor(() => expect(listMeals).toHaveBeenCalled());
    expect(view.queryByText('Kroger Brands Integration')).toBeNull();
  });

  it('appears for an account with a meal saved at one, including a sister banner', async () => {
    // Ralphs, not Kroger itself: the point is the family, which is what
    // isKrogerBrand knows and a name check would not.
    listMeals.mockResolvedValue([krogerMeal] as any);
    const view = render(<AccountScreen />);
    await waitFor(() => expect(view.getByText('Kroger Brands Integration')).toBeTruthy());
  });

  it('never offers its own disconnect, whichever way it is shown', async () => {
    listMeals.mockResolvedValue([krogerMeal] as any);
    const view = render(<AccountScreen />);
    await waitFor(() => expect(view.getByText('Kroger Brands Integration')).toBeTruthy());
    expect(view.queryByText('Disconnect Kroger')).toBeNull();
  });
});

describe('signing out of stores', () => {
  it('offers exactly one control, and it does not name a store', async () => {
    listMeals.mockResolvedValue([krogerMeal] as any);
    const view = render(<AccountScreen />);
    await waitFor(() => expect(view.getByText('Sign out of my stores')).toBeTruthy());
    expect(view.queryAllByText('Sign out of my stores')).toHaveLength(1);
    expect(view.queryByText('Disconnect Kroger')).toBeNull();
  });

  it('does not say which stores the account is connected to', async () => {
    listMeals.mockResolvedValue([hebMeal] as any);
    const view = render(<AccountScreen />);
    await waitFor(() => expect(view.getByText('Sign out of my stores')).toBeTruthy());
    // The old card's two halves: the list itself, and the caveat that existed
    // only because the list could not be trusted.
    expect(view.queryByText('Connected grocery stores')).toBeNull();
    expect(view.queryByText(/No store sign-ins confirmed/)).toBeNull();
    expect(view.queryByText(/including any not listed above/)).toBeNull();
  });
});

describe('section headings', () => {
  it('has no empty Your meals heading', async () => {
    const view = render(<AccountScreen />);
    await waitFor(() => expect(listMeals).toHaveBeenCalled());
    expect(view.queryByText('Your meals')).toBeNull();
  });
});
