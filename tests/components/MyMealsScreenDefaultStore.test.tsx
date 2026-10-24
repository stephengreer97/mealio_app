// My Meals with one store per account: a "Your store" switcher instead of
// store tabs, every meal shown, and New Meal asking for a store only before the
// account has one.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void) => {
    const RealReact = jest.requireActual('react');
    RealReact.useEffect(() => cb(), []);
  },
}));

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

// Heavy children the form does not need. Each pulls a native module of its own
// (WebView, purchases, the cart engine) and none of them render the picker.
jest.mock('../../src/components/MealDetailSheet', () => () => null);
jest.mock('../../src/components/KrogerCartReviewSheet', () => () => null);
jest.mock('../../src/components/WebViewCartSheet', () => () => null);
jest.mock('../../src/components/ProductChooserSheet', () => () => null);
jest.mock('../../src/components/MealCard', () => () => null);
jest.mock('../../src/components/PhotoPicker', () => () => null);

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));

jest.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', tier: 'paid' }, isCreator: false, refreshUser: jest.fn() }),
}));
jest.mock('../../src/context/CartJobContext', () => ({ useCartJob: () => ({ startJob: jest.fn() }) }));
jest.mock('../../src/context/LoginPrewarmContext', () => ({
  useLoginPrewarm: () => ({ checkStore: jest.fn(), statusFor: () => 'unknown' }),
}));

jest.mock('../../src/lib/api', () => ({
  account: {
    getDefaultStore: jest.fn(async () => 'heb'),
    setDefaultStore: jest.fn(async (storeId: string) => ({ defaultStoreId: storeId, moved: 2 })),
  },
  meals: {
    list: jest.fn(async () => [
      { id: 'm1', name: 'Cereal', storeId: 'heb', ingredients: [{ ingredientName: 'milk', qty: 1, unit: 'qty' }] },
      { id: 'm2', name: 'Tacos', storeId: 'heb', ingredients: [{ ingredientName: 'tortillas', qty: 1, unit: 'qty' }] },
    ]),
    create: jest.fn(async (body: any) => ({ id: 'm1', ...body })),
    update: jest.fn(),
    delete: jest.fn(),
  },
  kroger: { status: jest.fn(async () => ({ connected: false, locations: {} })) },
  images: { upload: jest.fn() },
}));

import MyMealsScreen from '../../src/screens/mymeals/MyMealsScreen';
import { account as accountApi, meals as mealsApi } from '../../src/lib/api';
import { clearDefaultStore } from '../../src/lib/defaultStore';

const account = accountApi as any;
const api = mealsApi as any;

beforeEach(() => {
  clearDefaultStore();
  jest.clearAllMocks();
  account.getDefaultStore.mockResolvedValue('heb');
});
afterEach(() => jest.restoreAllMocks());

it('shows the account store with every meal under it', async () => {
  const r = render(<MyMealsScreen />);
  const store = await r.findByTestId('my-store');
  await waitFor(() => expect(store).toHaveTextContent(/H-E-B/));
  // No store tabs: there is one store, so nothing to pick between.
  expect(r.queryByText('Kroger')).toBeNull();
});

it('asks before switching, then moves the account', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons: any) => {
    buttons?.find((b: any) => b.style !== 'cancel')?.onPress?.();
  });
  // The server remembers the switch, as the real one does.
  account.setDefaultStore.mockImplementation(async (storeId: string) => {
    account.getDefaultStore.mockResolvedValue(storeId);
    return { defaultStoreId: storeId, moved: 2 };
  });
  const r = render(<MyMealsScreen />);
  await waitFor(() => expect(r.getByTestId('my-store')).toHaveTextContent(/H-E-B/));

  fireEvent.press(r.getByTestId('my-store'));
  fireEvent.changeText(await r.findByTestId('store-switcher-search'), 'kroger');
  fireEvent.press(await r.findByTestId('store-switcher-kroger'));

  expect(alert.mock.calls[0][0]).toBe('Switch to Kroger?');
  expect(alert.mock.calls[0][1]).toMatch(/Products you chose at H-E-B stay saved for H-E-B/);
  await waitFor(() => expect(account.setDefaultStore).toHaveBeenCalledWith('kroger'));
  await waitFor(() => expect(r.getByTestId('my-store')).toHaveTextContent(/Kroger/));
});

it('leaves the store out of New Meal once the account has one, and saves there', async () => {
  const r = render(<MyMealsScreen />);
  await waitFor(() => expect(r.getByTestId('my-store')).toHaveTextContent(/H-E-B/));
  fireEvent.press(await r.findByText('add'));
  await r.findByText('New Meal');

  expect(r.queryByText('Your store *')).toBeNull();
  fireEvent.changeText(r.getByPlaceholderText('e.g. Lemon Herb Chicken'), 'Soup');
  fireEvent.changeText(r.getByPlaceholderText('Ingredient name'), 'broth');
  fireEvent.press(r.getByText('Create Meal'));

  await waitFor(() => expect(api.create).toHaveBeenCalled());
  expect(api.create.mock.calls[0][0].storeId).toBe('heb');
});

it('asks for a store in New Meal before the account has one', async () => {
  account.getDefaultStore.mockResolvedValue(null);
  api.list.mockResolvedValue([]);
  const r = render(<MyMealsScreen />);
  fireEvent.press(await r.findByText('add'));
  await r.findByText('New Meal');
  expect(r.getByText('Your store *')).toBeTruthy();
});
