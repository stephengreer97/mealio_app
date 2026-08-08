// The `serves` rule on the creator portal's publish form.
//
// The field is a plain text input and the screen checked nothing, so "12
// pancakes" went to `POST /api/creator/meals` and came back as the server's
// sentence in an `Alert` — after Save Meal had been pressed, on a form that
// never said there was a rule.
//
// The rule itself lives in `src/constants/serves.ts` and is unit-tested there.
// What these assert is that this screen is wired to it, and — the half that is
// easy to get wrong — that it is wired to the *grandfathering* version. A client
// stricter than the route it posts to turns the 400 it was meant to pre-empt
// into a request never sent, which is the bug the route grandfathers against.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { SERVES_ERROR } from '../../src/constants/serves';

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

// Since MEAL-89 the portal renders the review queue in place of itself, and the
// queue reads this context, which reaches AuthContext and a good deal of the
// app behind it. The serves form is what is under test, so the context is
// stubbed the same way `creator-portal-queue-entry.test.tsx` stubs it. (This
// stub also used to be load-bearing for a second reason — AuthContext pulls
// `react-native-purchases`, whose ESM dist Jest could not parse. That is handled
// centrally now; see `__mocks__/react-native-purchases.js`. The isolation below
// is still wanted on its own merits.)
jest.mock('../../src/context/CreatorDraftsContext', () => ({
  useCreatorDrafts: () => ({ waiting: 0, refresh: jest.fn(), announce: jest.fn() }),
}));

jest.mock('../../src/components/MealDetailSheet', () => () => null);
jest.mock('../../src/components/PublishedLinkSheet', () => () => null);
jest.mock('../../src/components/PushOptInCard', () => () => null);
jest.mock('../../src/components/PhotoPicker', () => () => null);

const LEGACY = {
  id: 'p1',
  name: 'Guacamol',
  story: null,
  recipe: null,
  source: null,
  // Published before the rule existed — a yield, not a head count.
  serves: '2 1/2 cups',
  ingredients: [{ ingredientName: 'avocados', qty: 4, productQty: 1, unit: 'qty', measure: null, searchTerm: null }],
  tags: ['Mexican'],
  difficulty: null,
  photoUrl: null,
};

jest.mock('../../src/lib/api', () => ({
  creators: {
    getMe: jest.fn(async () => ({
      creator: { id: 'c1', displayName: 'Kate', approvedAt: '2026-01-01' },
      meals: [
        {
          id: 'p1',
          name: 'Guacamol',
          story: null,
          recipe: null,
          source: null,
          serves: '2 1/2 cups',
          ingredients: [{ ingredientName: 'avocados', qty: 4, productQty: 1, unit: 'qty', measure: null, searchTerm: null }],
          tags: ['Mexican'],
          difficulty: null,
          photoUrl: null,
        },
      ],
      stats: null,
    })),
    creatorMeals: {
      create: jest.fn(async (body: any) => ({ id: 'p2', ...body })),
      update: jest.fn(async (_id: string, body: any) => ({ id: 'p1', ...body })),
      delete: jest.fn(),
    },
  },
  images: { upload: jest.fn() },
}));

import CreatorPortalScreen from '../../src/screens/creator/CreatorPortalScreen';
import { creators as creatorsApi } from '../../src/lib/api';

const create = creatorsApi.creatorMeals.create as unknown as jest.Mock;
const update = creatorsApi.creatorMeals.update as unknown as jest.Mock;

let alerts: string[] = [];

beforeEach(() => {
  alerts = [];
  create.mockClear();
  update.mockClear();
  jest.spyOn(Alert, 'alert').mockImplementation((_title, message) => {
    alerts.push(String(message));
  });
});

afterEach(() => jest.restoreAllMocks());

/** Opens the publish form on a blank meal. */
async function openNewMealForm() {
  const r = render(<CreatorPortalScreen />);
  fireEvent.press(await r.findByText('+ New Meal'));
  await r.findByText('Meal Name *');
  return r;
}

/** Opens the edit form on the meal published before the rule existed. */
async function openLegacyEditForm() {
  const r = render(<CreatorPortalScreen />);
  fireEvent.press(await r.findByText('pencil-outline'));
  await r.findByDisplayValue('Guacamol');
  return r;
}

function fillPublishable(r: ReturnType<typeof render>) {
  fireEvent.changeText(r.getByPlaceholderText('e.g. Lemon Herb Chicken'), 'Guacamole');
  fireEvent.changeText(r.getByPlaceholderText('Ingredient name'), 'avocados');
}

describe('CreatorPortalScreen — the serves rule is stated before Save Meal', () => {
  it('refuses a yield in the server\'s own words, without posting', async () => {
    const r = await openNewMealForm();
    fillPublishable(r);

    fireEvent.changeText(r.getByPlaceholderText('e.g. 4 or 2-4'), '12 pancakes');
    fireEvent.press(r.getByText('Save Meal'));

    await waitFor(() => expect(alerts).toContain(SERVES_ERROR));
    // The point of checking on the client: the request is never sent.
    expect(create).not.toHaveBeenCalled();
  });

  it('publishes a head count', async () => {
    const r = await openNewMealForm();
    fillPublishable(r);

    fireEvent.changeText(r.getByPlaceholderText('e.g. 4 or 2-4'), '2-4');
    fireEvent.press(r.getByText('Save Meal'));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0].serves).toBe('2-4');
  });
});

describe('CreatorPortalScreen — editing a meal from before the rule', () => {
  it('saves a name-only fix, rather than refusing on a field never opened', async () => {
    // The form posts `serves` on every save. Checking what is in the box rather
    // than what changed would lose this edit and blame a field the creator did
    // not touch — the route grandfathers it, and the client must not be
    // stricter than the route it posts to.
    const r = await openLegacyEditForm();

    fireEvent.changeText(r.getByDisplayValue('Guacamol'), 'Guacamole');
    fireEvent.press(r.getByText('Save Meal'));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(alerts).not.toContain(SERVES_ERROR);
    expect(update.mock.calls[0][1].name).toBe('Guacamole');
    // Posted back as it was: the route reads this to see the save did not
    // change it.
    expect(update.mock.calls[0][1].serves).toBe(LEGACY.serves);
  });

  it('still refuses a serves the creator is actually changing', async () => {
    const r = await openLegacyEditForm();

    fireEvent.changeText(r.getByDisplayValue('2 1/2 cups'), '3 loaves');
    fireEvent.press(r.getByText('Save Meal'));

    await waitFor(() => expect(alerts).toContain(SERVES_ERROR));
    expect(update).not.toHaveBeenCalled();
  });

  it('lets a legacy value be replaced with a head count', async () => {
    const r = await openLegacyEditForm();

    fireEvent.changeText(r.getByDisplayValue('2 1/2 cups'), '4');
    fireEvent.press(r.getByText('Save Meal'));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1].serves).toBe('4');
  });
});
