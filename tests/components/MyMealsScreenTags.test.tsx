// The tag cap on the personal-meal create form.
//
// `MyMealsScreen`'s New Meal form had no cap at all — the picker let a user
// select as many tags as they liked, and `POST /api/meals` counts them now. It
// renders the shared `TagPicker` rather than a fourth hand-rolled copy, and
// this is the test that the swap happened: the screen is heavy enough that a
// silent revert to the old inline picker would otherwise go unnoticed.
//
// The picker's own behaviour is covered in `TagPicker.test.tsx`. What is
// asserted here is that this form is wired to it, and that what the form posts
// is inside the cap the route enforces.

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
jest.mock('../../src/lib/purchases', () => ({ getOffering: jest.fn(), purchasePackage: jest.fn() }));

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
    update: jest.fn(),
    delete: jest.fn(),
  },
  kroger: { status: jest.fn(async () => ({ connected: false, locations: {} })) },
  images: { upload: jest.fn() },
}));

import MyMealsScreen from '../../src/screens/mymeals/MyMealsScreen';
import Tag from '../../src/components/ui/Tag';
import { meals as mealsApi } from '../../src/lib/api';

type Chip = { props: { label: string; disabled?: boolean; onPress: () => void } };
const chipFor = (r: { UNSAFE_getAllByType: (t: unknown) => Chip[] }, label: string): Chip =>
  r.UNSAFE_getAllByType(Tag).find((c) => c.props.label === label)!;

/** Renders the screen and opens New Meal, which is where the picker lives. */
async function openCreateForm() {
  const r = render(<MyMealsScreen />);
  fireEvent.press(await r.findByText('add'));
  await r.findByText('New Meal');
  return r;
}

describe('MyMealsScreen — the New Meal form caps tags', () => {
  it('renders the shared picker, with its count', async () => {
    const r = await openCreateForm();
    expect(r.getByTestId('tag-picker-count').props.children).toBe('0 of 3 chosen');
  });

  it('stops at the cap instead of taking as many as it is given', async () => {
    const r = await openCreateForm();

    fireEvent.press(r.getByText('Mexican'));
    fireEvent.press(r.getByText('No Cook'));
    fireEvent.press(r.getByText('Vegan'));

    expect(r.getByTestId('tag-picker-count').props.children).toBe('3 of 3 chosen');
    // The fourth is faded and inert. This form had no notion of that at all.
    expect(chipFor(r as never, 'Healthy').props.disabled).toBe(true);
    expect(chipFor(r as never, 'Mexican').props.disabled).toBe(false);
  });

  it('posts no more tags than the route will accept', async () => {
    const r = await openCreateForm();

    // A publishable meal: name, store and one ingredient are all required
    // before `Create Meal` will post anything.
    fireEvent.changeText(r.getByPlaceholderText('e.g. Lemon Herb Chicken'), 'Tacos');
    fireEvent.press(r.getByText('Select a store…'));
    fireEvent.press(await r.findByText('ALDI'));
    fireEvent.changeText(r.getByPlaceholderText('Ingredient name'), 'tortillas');

    fireEvent.press(r.getByText('Mexican'));
    fireEvent.press(r.getByText('No Cook'));
    fireEvent.press(r.getByText('Vegan'));
    // Pressed anyway, which is what a user does: the picker refuses it.
    fireEvent.press(r.getByText('Healthy'));

    fireEvent.press(r.getByText('Create Meal'));

    await waitFor(() => expect(mealsApi.create).toHaveBeenCalled());
    const body = (mealsApi.create as unknown as jest.Mock).mock.calls[0][0];
    expect(body.tags).toEqual(['Mexican', 'No Cook', 'Vegan']);
  });
});
