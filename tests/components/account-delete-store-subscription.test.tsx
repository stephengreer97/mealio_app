// What account deletion tells a paying user about store subscriptions.

import { Alert } from 'react-native';
import { render, waitFor, fireEvent } from '@testing-library/react-native';

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

let mockTier = 'free';
const mockLogout = jest.fn(async () => {});
jest.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.co', tier: mockTier, firstName: 'Sam', lastName: 'Lee' },
    logout: mockLogout,
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
  account: { changePassword: jest.fn(), deleteAccount: jest.fn() },
  creators: { getMe: jest.fn(async () => ({ creator: null, application: null })), updateMe: jest.fn() },
  kroger: { status: jest.fn(async () => ({ connected: false, locations: {} })), disconnect: jest.fn() },
  images: { upload: jest.fn() },
}));

import AccountScreen from '../../src/screens/account/AccountScreen';
import { account as accountApi } from '../../src/lib/api';

// Deleting a Mealio account cancels a Stripe subscription on the server, but it
// cannot touch an App Store or Google Play one: only the user can cancel that,
// in the store. So a paid user is told before they confirm, and the server's
// notice (sent when it found no Stripe subscription to cancel) is shown after.

const deleteAccount = accountApi.deleteAccount as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockTier = 'free';
});

async function openDeleteModal() {
  const view = render(<AccountScreen />);
  fireEvent.press(await view.findByText('Delete Account'));
  await view.findByText('Type "Delete Account" to confirm:');
  return view;
}

describe('deleting an account', () => {
  it('warns a paid user that store subscriptions must be cancelled in the store', async () => {
    mockTier = 'paid';
    const view = await openDeleteModal();
    expect(view.getByTestId('delete-store-subscription-warning')).toBeTruthy();
  });

  it('does not warn a free user about a subscription they do not have', async () => {
    const view = await openDeleteModal();
    expect(view.queryByTestId('delete-store-subscription-warning')).toBeNull();
  });

  it("shows the server's notice after the account is deleted", async () => {
    mockTier = 'paid';
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    deleteAccount.mockResolvedValue({ success: true, notice: 'Cancel it in the App Store.' });
    const view = await openDeleteModal();
    fireEvent.changeText(view.getByPlaceholderText('Delete Account'), 'Delete Account');
    fireEvent.press(view.getByText('Delete'));
    await waitFor(() => expect(mockLogout).toHaveBeenCalled());
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Your account is deleted', 'Cancel it in the App Store.'));
  });
});
