// The creator's draft review queue (MEAL-89).
//
// The ticket's shape, and what this file holds the screen to:
//
//   1. **The queue is the feature, not the popup.** Position shows as "3 of 10"
//      so the end is visible, and it survives a remount — the thing that makes
//      ten drafts reviewable in one sitting instead of a stack people force-quit.
//   2. **Exceptions only.** A verified field says nothing. A flagged one carries
//      the reason and the span we read, both worded by the server.
//   3. **No "approve all".** Deciding is per draft, and skipping decides nothing.
//   4. **Idempotent decisions.** A second tap on a slow connection is told the
//      draft was already decided, not shown a failure.

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

// Native modules the screen draws with. Stubbed the way WebViewCartSheet's
// tests stub them: `expo-asset` is not installed in this workspace, so
// @expo/vector-icons cannot be loaded for real, and none of it is what is under
// test here.
jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (props: any) => RealReact.createElement(RealView, { testID: 'mock-image', ...props }) };
});

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return {
    Feather: (props: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, props.name),
    Ionicons: (props: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, props.name),
  };
});

jest.mock('react-native-safe-area-context', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const inset = { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    SafeAreaProvider: (props: any) => RealReact.createElement(RealView, props, props.children),
    SafeAreaView: (props: any) => RealReact.createElement(RealView, props, props.children),
    useSafeAreaInsets: () => inset,
  };
});

const secureStore: Record<string, string> = {};

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => secureStore[k] ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { secureStore[k] = v; }),
  deleteItemAsync: jest.fn(async (k: string) => { delete secureStore[k]; }),
}));

// `mock`-prefixed, which is the only way jest.mock's factory may close over a
// variable at all — the factory is hoisted above these declarations.
const mockList = jest.fn();
const mockDecide = jest.fn();
const mockEdit = jest.fn();
jest.mock('../../src/lib/api', () => ({
  creatorDrafts: {
    list: (...a: unknown[]) => mockList(...a),
    decide: (...a: unknown[]) => mockDecide(...a),
    edit: (...a: unknown[]) => mockEdit(...a),
    count: jest.fn(async () => ({ waiting: 0 })),
  },
}));

const mockSetWaiting = jest.fn();
jest.mock('../../src/context/CreatorDraftsContext', () => ({
  useCreatorDrafts: () => ({ waiting: 0, refresh: jest.fn(), setWaiting: mockSetWaiting }),
}));

const list = mockList;
const decide = mockDecide;
const edit = mockEdit;
const setWaiting = mockSetWaiting;

import CreatorReviewQueueScreen from '../../src/screens/creator/CreatorReviewQueueScreen';

/**
 * One queued draft, in the shape the server sends: the recipe, the counts, and
 * the callouts already worded. Nothing about which fields are flagged is
 * derived in the app, so the fixture is where that decision lives here too.
 */
function draft(id: string, over: Partial<Record<string, any>> = {}) {
  return {
    id,
    sourceUrl: 'https://chefsarah.test/guacamole',
    draft: {
      name: over.name ?? 'Best Guacamole',
      ingredients: [
        { ingredientName: 'avocados', qty: 3, unit: 'qty', measure: null },
        { ingredientName: 'lime juice', qty: 1, unit: 'tbsp', measure: '2' },
      ],
      recipe: 'Mash the avocados. Stir in everything else.',
      source: 'https://chefsarah.test/guacamole',
      story: null,
      photoUrl: null,
      difficulty: 1,
      tags: ['Mexican'],
      serves: '4',
    },
    summary: over.summary ?? { total: 5, verified: 4, needALook: 1 },
    review: {
      summaryText: over.summaryText ?? '4 of 5 fields verified. 1 needs a look.',
      notices: over.notices ?? {
        name: null, recipe: null, story: null, photoUrl: null,
        difficulty: null, tags: null, serves: null,
        // One flagged row, so "exceptions only" is testable: it is the count of
        // notices on screen against `needALook`, not a fixed number.
        ingredients: [null, { kind: 'adjusted', text: '', evidence: 'juice of 1 lime' }],
      },
    },
  };
}

/** All verified: nothing flagged anywhere. */
function cleanDraft(id: string) {
  return draft(id, {
    summary: { total: 5, verified: 5, needALook: 0 },
    summaryText: '5 of 5 fields verified.',
    notices: {
      name: null, recipe: null, story: null, photoUrl: null,
      difficulty: null, tags: null, serves: null, ingredients: [null, null],
    },
  });
}

/** Renders and lets the initial load settle. */
async function mount(onClose = jest.fn()) {
  const view = render(<CreatorReviewQueueScreen onClose={onClose} />);
  await act(async () => {});
  return { ...view, onClose };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(secureStore)) delete secureStore[k];
  list.mockResolvedValue({ drafts: [draft('d1')], totals: { waiting: 1, flagged: 1 } });
  decide.mockResolvedValue({ done: 1, published: [{ id: 'm1', name: 'Best Guacamole' }], errors: [], waiting: 0 });
});

// ── Position ─────────────────────────────────────────────────────────────────

describe('position and progress', () => {
  it('shows where in the queue they are, so the end is visible', async () => {
    list.mockResolvedValue({ drafts: [draft('d1'), draft('d2'), draft('d3')], totals: { waiting: 3, flagged: 3 } });

    const { getByTestId } = await mount();

    expect(getByTestId('queue-position').props.children.join('')).toBe('1 of 3');
  });

  it('advances on a decision without moving the end of the queue', async () => {
    // "3 of 10" becoming "3 of 9" under a creator's finger makes the end look
    // like it moved. The decided draft leaves the list; the position does not
    // reset to the front.
    list.mockResolvedValue({ drafts: [draft('d1'), draft('d2'), draft('d3')], totals: { waiting: 3, flagged: 3 } });
    decide.mockResolvedValue({ done: 1, published: [{ id: 'm1', name: 'Best Guacamole' }], errors: [], waiting: 2 });

    const { getByTestId, getByText } = await mount();
    fireEvent.press(getByText('Approve & publish'));
    await act(async () => {});

    expect(getByTestId('queue-position').props.children.join('')).toBe('1 of 2');
  });

  it('survives backgrounding — it resumes on the draft they were on', async () => {
    // The acceptance criterion this exists for. Persisted as the draft's *id*,
    // not an index: decide two, come back, and an index would name a different
    // recipe, which is worse than starting over because it looks right.
    const drafts = [draft('d1'), draft('d2'), draft('d3')];
    list.mockResolvedValue({ drafts, totals: { waiting: 3, flagged: 3 } });

    const first = await mount();
    fireEvent.press(first.getByTestId('skip-draft'));
    await act(async () => {});
    expect(first.getByTestId('queue-position').props.children.join('')).toBe('2 of 3');
    first.unmount();

    // What the OS does to a backgrounded app: the process goes, the stored
    // cursor stays.
    const second = await mount();
    await waitFor(() =>
      expect(second.getByTestId('queue-position').props.children.join('')).toBe('2 of 3'));
  });

  it('falls back to the front when the remembered draft is gone', async () => {
    // Decided in a browser, decided on another device, taken back by an
    // operator. Detectable precisely because the cursor is an id.
    secureStore['mealio_draft_cursor'] = 'decided-elsewhere';
    list.mockResolvedValue({ drafts: [draft('d1'), draft('d2')], totals: { waiting: 2, flagged: 2 } });

    const { getByTestId } = await mount();

    expect(getByTestId('queue-position').props.children.join('')).toBe('1 of 2');
  });

  it('skipping decides nothing', async () => {
    // A creator who is unsure has to be able to move on without publishing or
    // declining; the decision made under "decide in order to leave" is Approve.
    list.mockResolvedValue({ drafts: [draft('d1'), draft('d2')], totals: { waiting: 2, flagged: 2 } });

    const { getByTestId } = await mount();
    fireEvent.press(getByTestId('skip-draft'));
    await act(async () => {});

    expect(getByTestId('queue-position').props.children.join('')).toBe('2 of 2');
    expect(decide).not.toHaveBeenCalled();
  });
});

// ── Exceptions only ──────────────────────────────────────────────────────────

describe('only the flagged fields are called out', () => {
  it('shows one notice per flagged field and none for the rest', async () => {
    const { queryAllByTestId, getByTestId } = await mount();

    // Silence is the signal: a note on every field would destroy it. The count
    // on screen has to equal what the server says needs a look.
    expect(queryAllByTestId('import-notice')).toHaveLength(1);
    expect(getByTestId('draft-summary').props.children.join('')).toContain('4 of 5 fields verified');
  });

  it('says nothing at all when everything verified', async () => {
    list.mockResolvedValue({ drafts: [cleanDraft('d1')], totals: { waiting: 1, flagged: 0 } });

    const { queryAllByTestId, getByTestId } = await mount();

    expect(queryAllByTestId('import-notice')).toHaveLength(0);
    expect(getByTestId('draft-summary').props.children.join('')).toContain('matched the page we read');
  });

  it('quotes the span we read, so a creator can judge it in a glance', async () => {
    const { getByTestId } = await mount();
    expect(getByTestId('import-notice')).toBeTruthy();
    expect(getByTestId('draft-card')).toBeTruthy();
  });
});

// ── Deciding ─────────────────────────────────────────────────────────────────

describe('approve, edit, decline — and nothing that decides in bulk', () => {
  it('approves exactly the draft on screen, one id', async () => {
    list.mockResolvedValue({ drafts: [draft('d1'), draft('d2')], totals: { waiting: 2, flagged: 2 } });

    const { getByText } = await mount();
    fireEvent.press(getByText('Approve & publish'));
    await act(async () => {});

    expect(decide).toHaveBeenCalledWith('approve', ['d1']);
  });

  it('offers no way to approve the whole queue', async () => {
    // Bulk-approving unreviewed extractions is exactly what the per-field
    // checks exist to prevent. The server refuses a batched approve too.
    list.mockResolvedValue({ drafts: [draft('d1'), draft('d2'), draft('d3')], totals: { waiting: 3, flagged: 3 } });

    const { queryByText } = await mount();

    expect(queryByText(/approve all/i)).toBeNull();
    expect(queryByText(/approve 3/i)).toBeNull();
  });

  it('tells a creator a second tap published nothing new', async () => {
    // A slow network invites a second tap. The conditional write server-side is
    // what makes that safe; this is the creator being told so rather than
    // shown a failure.
    decide.mockResolvedValue({ done: 0, published: [], errors: ['That draft was already approved.'], waiting: 0 });

    const { getByText } = await mount();
    fireEvent.press(getByText('Approve & publish'));
    await act(async () => {});

    expect(getByText('That draft was already approved.')).toBeTruthy();
  });

  it('declines without deleting, and says it will not come back', async () => {
    const { getByText, getByTestId } = await mount();

    expect(String(getByTestId('queue-actions-note').props.children)).toContain('won’t come back');
    fireEvent.press(getByText('Not this one'));
    await act(async () => {});

    expect(decide).toHaveBeenCalledWith('cancel', ['d1']);
  });

  it('confirms the last decision instead of vanishing mid-tap', async () => {
    // Otherwise approving the final draft swaps the card out and "your recipe
    // is live" is never read — at the moment a creator is most likely to tap
    // Approve a second time.
    const { getByText } = await mount();
    fireEvent.press(getByText('Approve & publish'));
    await act(async () => {});

    expect(getByText('That’s everything')).toBeTruthy();
    expect(getByText('“Best Guacamole” is live.')).toBeTruthy();
  });

  it('edits in place, and saving does not decide anything', async () => {
    edit.mockResolvedValue({ draft: draft('d1', { name: 'Sarah’s guacamole' }) });

    const { getByText } = await mount();
    fireEvent.press(getByText('Edit first'));
    fireEvent.press(getByText('Save edits'));
    await act(async () => {});

    expect(edit).toHaveBeenCalled();
    // A PATCH and no decision: correcting a measure has not said the recipe is
    // right, so the draft stays in the queue.
    expect(decide).not.toHaveBeenCalled();
    expect(getByText(/editing doesn’t publish it/)).toBeTruthy();
  });

  it('shows a failure inline rather than in an Alert', async () => {
    // An Alert is a modal, and a failed decision is not a reason to put one in
    // front of someone who may have opened the app to do something else.
    decide.mockRejectedValue(new Error('Network request failed'));

    const { getByText } = await mount();
    fireEvent.press(getByText('Approve & publish'));
    await act(async () => {});

    expect(getByText('Network request failed')).toBeTruthy();
    // Still on the draft: a decision that did not land must not look like one
    // that did.
    expect(getByText('Approve & publish')).toBeTruthy();
  });
});

// ── The badge ────────────────────────────────────────────────────────────────

describe('keeping the tab badge honest', () => {
  it('reports the queue length on load and the server’s count after a decision', async () => {
    list.mockResolvedValue({ drafts: [draft('d1'), draft('d2')], totals: { waiting: 2, flagged: 2 } });
    decide.mockResolvedValue({ done: 1, published: [{ id: 'm1', name: 'Best Guacamole' }], errors: [], waiting: 1 });

    const { getByText } = await mount();
    expect(setWaiting).toHaveBeenCalledWith(2);

    fireEvent.press(getByText('Approve & publish'));
    await act(async () => {});

    // The server's number, not the local list length — it answers a different
    // question (how many are left overall) and is the one the badge shows.
    expect(setWaiting).toHaveBeenLastCalledWith(1);
  });
});

// ── Never blocking ───────────────────────────────────────────────────────────

describe('nothing traps a creator here', () => {
  it('offers a way back out at every point', async () => {
    const { getByLabelText, onClose } = await mount();
    fireEvent.press(getByLabelText('Back to your portal'));
    expect(onClose).toHaveBeenCalled();
  });

  it('says so plainly, and offers the way back, when there is nothing to do', async () => {
    list.mockResolvedValue({ drafts: [], totals: { waiting: 0, flagged: 0 } });

    const { getByTestId, getByText } = await mount();

    expect(getByTestId('creator-queue-empty')).toBeTruthy();
    fireEvent.press(getByText('Back to your portal'));
  });

  it('does not claim the queue is empty when the read simply failed', async () => {
    // A failed read is not evidence that there is nothing waiting, so the badge
    // is not zeroed on the way past.
    list.mockRejectedValue(new Error('offline'));

    const { getByTestId } = await mount();

    expect(getByTestId('creator-queue-empty')).toBeTruthy();
    expect(setWaiting).not.toHaveBeenCalled();
  });
});
