// CAN YOU ACTUALLY GET TO THE NOTIFICATION SETTINGS?
//
// Stephen: "are we expecting the notifications page in Account settings to have
// nothing in it?" No. Every account has at least one category. What was
// happening is that the LINK was gated on `pushStatus === 'on'`, and his device
// reports `unregistered`: the OS said yes and no token could be obtained,
// because the build has no FCM credentials.
//
// So the whole feature was unreachable on every Android build without FCM, and
// nothing tested the gate. The sheet had nine tests; the question of whether
// anyone could OPEN it had none. That is the [[measure-the-feature-not-the-
// function]] shape, and it is why this file asserts on the screen rather than
// on the condition.
import { render, waitFor } from '@testing-library/react-native';

const mockGetPushStatus = jest.fn();
jest.mock('../../src/lib/push', () => ({
  getPushStatus: () => mockGetPushStatus(),
  enablePush: jest.fn(),
  disablePush: jest.fn(),
  syncPushRegistration: jest.fn(async () => {}),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  const icon = (p: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, p.name);
  return { Ionicons: icon, Feather: icon, MaterialIcons: icon };
});
jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (p: any) => RealReact.createElement(RealView, p) };
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
jest.mock('@react-native-cookies/cookies', () => ({ clearAll: jest.fn(async () => {}) }));
jest.mock('../../src/lib/purchases', () => ({
  ENTITLEMENT_ID: 'full_access',
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
  getAllOfferings: jest.fn(async () => []),
  purchasePackage: jest.fn(async () => false),
  restorePurchases: jest.fn(async () => false),
  getActiveSubscriptionStore: jest.fn(async () => null),
  getEntitlementDetails: jest.fn(async () => null),
  getManagementURL: jest.fn(async () => null),
  onEntitlementChange: jest.fn(() => () => {}),
}));
jest.mock('react-native-purchases', () => ({ __esModule: true, default: {} }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({})) }));
jest.mock('../../src/components/NotificationSettingsSheet', () => () => null);
jest.mock('../../src/components/BugReportSheet', () => () => null);
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), getParent: () => null }),
  useFocusEffect: (cb: () => void) => {
    const RealReact = jest.requireActual('react');
    RealReact.useEffect(() => cb(), []);
  },
}));
jest.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.co', tier: 'free', firstName: 'Sam' },
    logout: jest.fn(), refreshUser: jest.fn(), isCreator: false,
  }),
}));
jest.mock('../../src/lib/api', () => ({
  account: { changePassword: jest.fn(), deleteAccount: jest.fn() },
  meals: { list: jest.fn(async () => []) },
  creators: { me: jest.fn(async () => null) },
  payments: { portal: jest.fn() },
  kroger: { status: jest.fn(async () => ({ connected: false })) },
}));

import AccountScreen from '../../src/screens/account/AccountScreen';

const openScreen = async (status: string) => {
  mockGetPushStatus.mockResolvedValue(status);
  const view = render(<AccountScreen />);
  await waitFor(() => expect(view.queryByText('Notifications')).toBeTruthy());
  return view;
};

beforeEach(() => { jest.clearAllMocks(); });

describe('reaching the notification settings', () => {
  it('is offered when notifications are on', async () => {
    const view = await openScreen('on');
    expect(view.queryByTestId('open-notification-settings')).toBeTruthy();
  });

  it('IS OFFERED when registration failed, which is the bug', async () => {
    // `unregistered` is a failure, not a preference: the user asked for
    // notifications and the device could not get a token. Their categories are
    // per account, store fine, and apply the moment a token exists.
    const view = await openScreen('unregistered');
    expect(view.queryByTestId('open-notification-settings')).toBeTruthy();
  });

  it('is NOT offered when notifications are simply off', async () => {
    // Here the gate is right. Choosing which notifications to receive means
    // nothing to someone who receives none by choice, and it would be a screen
    // of switches that change nothing.
    const view = await openScreen('off');
    expect(view.queryByTestId('open-notification-settings')).toBeNull();
  });

  it('is NOT offered when the OS has blocked them', async () => {
    const view = await openScreen('blocked');
    expect(view.queryByTestId('open-notification-settings')).toBeNull();
  });
});
