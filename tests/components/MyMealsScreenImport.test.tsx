// New Meal filled from "Import a recipe": the imported fields are what Create
// Meal sends, and the store is still the user's to pick.

import { fireEvent, render, waitFor } from '@testing-library/react-native';

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
  meals: {
    list: jest.fn(async () => ({ meals: [] })),
    create: jest.fn(async (body: any) => ({ id: 'm1', ...body })),
    importRecipe: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  kroger: { status: jest.fn(async () => ({ connected: false, locations: {} })) },
  images: { upload: jest.fn() },
}));

import MyMealsScreen from '../../src/screens/mymeals/MyMealsScreen';
import { meals as mealsApi } from '../../src/lib/api';

const api = mealsApi as any;
const URL_ = 'https://blog.example.com/pasta';

beforeEach(() => {
  jest.clearAllMocks();
  api.importRecipe.mockResolvedValue({
    status: 'ok',
    url: URL_,
    freeImportsLeft: null,
    draft: {
      name: 'Garlic Pasta',
      ingredients: [{ ingredientName: 'spaghetti', measure: '200', unit: 'g', qty: 1 }],
      recipe: 'Boil. Fry. Toss.',
      source: URL_,
      story: 'A weeknight staple.',
      photoUrl: 'https://storage.example/u1/pasta.jpg',
      difficulty: 2,
      tags: ['Italian'],
      serves: '2',
    },
    confidence: { ingredients: [{ level: 'green' }] },
  });
});

it('saves what the import filled in, at the store the user picked', async () => {
  const r = render(<MyMealsScreen />);
  fireEvent.press(await r.findByText('add'));
  await r.findByText('New Meal');

  fireEvent.changeText(r.getByTestId('meal-import-url'), URL_);
  fireEvent.press(r.getByTestId('meal-import-go'));
  await r.findByTestId('meal-import-done');

  expect(r.getByDisplayValue('Garlic Pasta')).toBeTruthy();
  fireEvent.press(r.getByText('Select a store…'));
  fireEvent.press(await r.findByText('ALDI'));
  fireEvent.press(r.getByText('Create Meal'));

  await waitFor(() => expect(api.create).toHaveBeenCalled());
  expect(api.create.mock.calls[0][0]).toMatchObject({
    name: 'Garlic Pasta',
    storeId: 'aldi',
    recipe: 'Boil. Fry. Toss.',
    story: 'A weeknight staple.',
    website: URL_,
    photoUrl: 'https://storage.example/u1/pasta.jpg',
    difficulty: 2,
    tags: ['Italian'],
    ingredients: [expect.objectContaining({ ingredientName: 'spaghetti', unit: 'g', measure: '200' })],
  });
});
