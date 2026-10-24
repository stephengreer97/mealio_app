// "Import a recipe" on New Meal: a link or pasted text fills the form, and
// every answer that is not a draft leaves the user a next step.

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('../../src/lib/api', () => ({
  meals: { importRecipe: jest.fn() },
}));

import { ApiError } from '../../src/lib/authErrors';
import MealImportPanel, { DOTS_STEP_MS, fieldsToCheck } from '../../src/components/MealImportPanel';
import { meals as mealsApi } from '../../src/lib/api';

const api = mealsApi as any;
const URL_ = 'https://blog.example.com/pasta';

const green = { level: 'green' };
const OK = {
  status: 'ok',
  url: URL_,
  freeImportsLeft: null,
  draft: {
    name: 'Garlic Pasta',
    ingredients: [
      { ingredientName: 'spaghetti', measure: '200', unit: 'g', qty: 1 },
      { ingredientName: 'garlic', measure: null, unit: 'qty', qty: 2 },
    ],
    recipe: 'Boil. Fry. Toss.',
    source: URL_,
    story: null,
    photoUrl: null,
    difficulty: null,
    tags: [],
    serves: null,
  },
  confidence: { name: green, recipe: green, ingredients: [green, { level: 'amber' }] },
};

const refusal = (status: number, body: Record<string, unknown>) => new ApiError(status, String(body.error ?? 'refused'), body);

function setup() {
  const onImported = jest.fn();
  const onUpgrade = jest.fn();
  const onOpenCreatorMeal = jest.fn();
  const r = render(<MealImportPanel onImported={onImported} onUpgrade={onUpgrade} onOpenCreatorMeal={onOpenCreatorMeal} />);
  const importLink = () => {
    fireEvent.changeText(r.getByTestId('meal-import-url'), URL_);
    fireEvent.press(r.getByTestId('meal-import-go'));
  };
  return { r, onImported, onUpgrade, onOpenCreatorMeal, importLink };
}

beforeEach(() => {
  jest.clearAllMocks();
  api.importRecipe.mockResolvedValue(OK);
});

describe('MealImportPanel', () => {
  it('imports a link, hands the draft to the form, and names what to check', async () => {
    const { r, onImported, importLink } = setup();
    importLink();

    const done = await r.findByTestId('meal-import-done');
    expect(onImported).toHaveBeenCalledWith(OK);
    expect(api.importRecipe).toHaveBeenCalledWith({ url: URL_ }, {});
    expect(done).toHaveTextContent(/blog\.example\.com/);
    expect(done).toHaveTextContent(/Check garlic before saving/);
  });

  it('cycles . .. ... while the import runs, then puts the button back', async () => {
    jest.useFakeTimers();
    try {
      let release!: (v: unknown) => void;
      api.importRecipe.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
      const { r, importLink } = setup();
      importLink();

      const dots = () => r.getByTestId('meal-import-dots').props.children;
      expect(r.getByText('Reading the recipe')).toBeTruthy();
      expect(r.getByText('This takes about 10 seconds.')).toBeTruthy();
      expect(dots()).toBe('.');
      act(() => { jest.advanceTimersByTime(DOTS_STEP_MS); });
      expect(dots()).toBe('..');
      act(() => { jest.advanceTimersByTime(DOTS_STEP_MS); });
      expect(dots()).toBe('...');
      act(() => { jest.advanceTimersByTime(DOTS_STEP_MS); });
      expect(dots()).toBe('.');

      await act(async () => { release(OK); });
      expect(r.queryByTestId('meal-import-thinking')).toBeNull();
      expect(r.getByTestId('meal-import-go')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('says when that was the free import', async () => {
    api.importRecipe.mockResolvedValue({ ...OK, freeImportsLeft: 0 });
    const { r, importLink } = setup();
    importLink();
    expect(await r.findByTestId('meal-import-done')).toHaveTextContent(/free import/);
  });

  it('imports pasted text and counts characters against the limit', async () => {
    const { r } = setup();
    fireEvent.press(r.getByTestId('meal-import-tab-text'));
    const text = 'Garlic pasta. 200 g spaghetti and 2 cloves of garlic, fried and tossed.';
    fireEvent.changeText(r.getByTestId('meal-import-text'), text);
    expect(r.getByTestId('meal-import-count')).toHaveTextContent(`${text.length} / 20,000 characters`);

    fireEvent.press(r.getByTestId('meal-import-go'));
    await r.findByTestId('meal-import-done');
    expect(api.importRecipe).toHaveBeenCalledWith({ text }, {});
  });

  it('will not send text too short to be a recipe', () => {
    const { r } = setup();
    fireEvent.press(r.getByTestId('meal-import-tab-text'));
    fireEvent.changeText(r.getByTestId('meal-import-text'), 'pasta');
    fireEvent.press(r.getByTestId('meal-import-go'));
    expect(api.importRecipe).not.toHaveBeenCalled();
  });

  it('offers the creator’s version, or a private copy on request', async () => {
    api.importRecipe.mockRejectedValueOnce(refusal(409, { status: 'creator-match', meal: { id: 'p1', name: 'Garlic Pasta', creatorName: 'Chef Sarah' } }));
    const { r, onOpenCreatorMeal, importLink } = setup();
    importLink();

    await r.findByTestId('meal-import-creator-match');
    fireEvent.press(r.getByText('See Chef Sarah’s version'));
    expect(onOpenCreatorMeal).toHaveBeenCalledWith('p1');

    fireEvent.press(r.getByText('Import my own copy'));
    await r.findByTestId('meal-import-done');
    expect(api.importRecipe).toHaveBeenLastCalledWith({ url: URL_ }, { ignoreCreatorMatch: true });
  });

  it('asks before importing a link the user already has', async () => {
    api.importRecipe.mockRejectedValueOnce(refusal(409, { status: 'duplicate', meal: { id: 'm1', name: 'My pasta' } }));
    const { r, importLink } = setup();
    importLink();

    expect(await r.findByTestId('meal-import-duplicate')).toHaveTextContent(/My pasta/);
    fireEvent.press(r.getByText('Import it again'));
    await r.findByTestId('meal-import-done');
    expect(api.importRecipe).toHaveBeenLastCalledWith({ url: URL_ }, { ignoreCreatorMatch: true, ignoreDuplicate: true });
  });

  it('sends a free user who has used their import to the purchase', async () => {
    api.importRecipe.mockRejectedValueOnce(refusal(402, { status: 'upgrade-required', error: 'You have used your free import.' }));
    const { r, onUpgrade, importLink } = setup();
    importLink();

    await r.findByTestId('meal-import-upgrade');
    fireEvent.press(r.getByText('Get Full Access'));
    expect(onUpgrade).toHaveBeenCalled();
  });

  it('offers the paste box when the site would not let us read it', async () => {
    api.importRecipe.mockRejectedValueOnce(
      refusal(422, { status: 'rejected', stage: 'fetch', detail: 'The site refused us.', suggestPaste: true }),
    );
    const { r, importLink } = setup();
    importLink();

    expect(await r.findByTestId('meal-import-error')).toHaveTextContent(/The site refused us/);
    fireEvent.press(r.getByText('Paste the recipe text instead'));
    await waitFor(() => expect(r.getByTestId('meal-import-text')).toBeTruthy());
  });
});

describe('fieldsToCheck', () => {
  it('lists unsure fields the import wrote, and nothing for clean ones', () => {
    expect(fieldsToCheck(OK as any)).toEqual(['garlic']);
    expect(fieldsToCheck({ ...OK, confidence: { name: { level: 'red' }, ingredients: [green, green] } } as any)).toEqual(['the name']);
  });

  it('counts rather than lists a long run of unsure ingredients', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ingredientName: `item ${i}`, unit: 'qty', qty: 1 }));
    const result = { ...OK, draft: { ...OK.draft, ingredients: many }, confidence: { ingredients: many.map(() => ({ level: 'amber' })) } };
    expect(fieldsToCheck(result as any)).toEqual(['5 ingredients']);
  });
});
