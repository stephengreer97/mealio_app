// The pending-draft count on the Creator tab (MEAL-89).
//
// Two rules, and both are about a creator who did not open the app to review
// anything:
//
//   1. **A badge and nothing else.** Nothing navigates, alerts, or opens. A
//      creator who launched the app to add a meal to their cart gets to do that,
//      and going to deal with the drafts is their decision.
//   2. **The count, never a dot.** "10" tells a creator to set an evening aside
//      and "1" tells them it is a two-minute job. A dot says the same thing to
//      both, which is the one piece of information they need.
//
// It also has to work without push at all: the count is a plain GET on launch
// and on foreground, so a creator who denied notifications — or is running Expo
// Go, where remote push does not exist — sees the same badge as everyone else.

import React from 'react';
import { act, render } from '@testing-library/react-native';
import { AppState, Text } from 'react-native';

/**
 * The AppState listener the provider registers, captured at subscribe time.
 *
 * `AppState.emit('change', ...)` does not reach it under jest-expo's React
 * Native mock — it returns silently, which makes a foreground test pass by
 * never running the code it is about. Spying on `addEventListener` and calling
 * the handler is the version that actually exercises the refresh.
 */
let foreground: ((state: string) => void) | null = null;

const mockCount = jest.fn();
jest.mock('../../src/lib/api', () => ({
  creatorDrafts: { count: (...a: unknown[]) => mockCount(...a) },
}));

const mockAuth = { user: null as { id: string } | null, isCreator: true };
jest.mock('../../src/context/AuthContext', () => ({ useAuth: () => mockAuth }));

import { CreatorDraftsProvider, useCreatorDrafts } from '../../src/context/CreatorDraftsContext';

/** Renders the count the provider is holding, so it can be asserted on. */
function Badge() {
  const { waiting } = useCreatorDrafts();
  return <Text testID="badge">{String(waiting)}</Text>;
}

async function mount() {
  const view = render(
    <CreatorDraftsProvider>
      <Badge />
    </CreatorDraftsProvider>,
  );
  await act(async () => {});
  return view;
}

const badge = (view: { getByTestId: (id: string) => any }) => view.getByTestId('badge').props.children;

beforeEach(() => {
  jest.clearAllMocks();
  foreground = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((event: string, handler: any) => {
    if (event === 'change') foreground = handler;
    return { remove: jest.fn() };
  }) as any);
  mockAuth.user = { id: 'u1' };
  mockAuth.isCreator = true;
  mockCount.mockResolvedValue({ waiting: 0 });
});

describe('the count', () => {
  it('is read on launch', async () => {
    mockCount.mockResolvedValue({ waiting: 10 });
    const view = await mount();
    expect(badge(view)).toBe('10');
  });

  it('is not asked for at all when nobody is signed in', async () => {
    mockAuth.user = null;
    const view = await mount();
    expect(mockCount).not.toHaveBeenCalled();
    expect(badge(view)).toBe('0');
  });

  it('is zero for a user who is not a creator, so no badge appears anywhere', async () => {
    // The endpoint answers 0 rather than failing, so the fetch is not gated on
    // knowing — but a stale count from a revoked creator row must not linger.
    mockCount.mockResolvedValue({ waiting: 4 });
    mockAuth.isCreator = false;
    const view = await mount();
    expect(badge(view)).toBe('0');
  });

  it('does not zero the badge when the read simply fails', async () => {
    // A failed request is not evidence that the queue is empty, and silently
    // clearing the badge would tell a creator there is nothing to do.
    mockCount.mockResolvedValue({ waiting: 3 });
    const view = await mount();
    expect(badge(view)).toBe('3');

    mockCount.mockRejectedValue(new Error('offline'));
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    await act(async () => { foreground!('active'); });
    (Date.now as jest.Mock).mockRestore?.();

    expect(badge(view)).toBe('3');
  });
});

describe('keeping up without a socket', () => {
  it('re-reads when the app comes back to the foreground', async () => {
    // Deliberately not realtime: a poller that produces drafts every fifteen
    // minutes does not justify a socket, and a foreground is the moment the
    // number is about to be looked at.
    jest.useFakeTimers();
    try {
      mockCount.mockResolvedValue({ waiting: 1 });
      const view = await mount();
      expect(badge(view)).toBe('1');

      mockCount.mockResolvedValue({ waiting: 5 });
      // Past the floor that keeps momentary interruptions from costing a
      // request — a share sheet, a permission dialog, the WebView cart run
      // handing control back, all of which bounce through `active`.
      jest.setSystemTime(Date.now() + 120_000);
      await act(async () => { foreground!('active'); });

      expect(badge(view)).toBe('5');
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores a foreground that follows a read a moment ago', async () => {
    mockCount.mockResolvedValue({ waiting: 1 });
    await mount();
    expect(mockCount).toHaveBeenCalledTimes(1);

    await act(async () => { foreground!('active'); });

    expect(mockCount).toHaveBeenCalledTimes(1);
  });

  it('takes the count a decision just returned, without another round trip', async () => {
    // The review screen calls this with the `waiting` its own POST came back
    // with, so the badge settles as the creator watches rather than a request
    // later.
    mockCount.mockResolvedValue({ waiting: 2 });

    let setWaiting: (n: number) => void = () => {};
    function Probe() {
      const ctx = useCreatorDrafts();
      setWaiting = ctx.setWaiting;
      return <Text testID="badge">{String(ctx.waiting)}</Text>;
    }
    const view = render(<CreatorDraftsProvider><Probe /></CreatorDraftsProvider>);
    await act(async () => {});
    expect(badge(view)).toBe('2');

    await act(async () => { setWaiting(1); });

    expect(badge(view)).toBe('1');
  });
});

describe('nothing but a badge', () => {
  it('exposes no way to navigate or interrupt', async () => {
    // The revised design in one assertion: the context hands out a number and
    // two functions for keeping it true, and nothing that could open a screen.
    mockCount.mockResolvedValue({ waiting: 9 });

    let value: Record<string, unknown> = {};
    function Probe() {
      value = useCreatorDrafts() as unknown as Record<string, unknown>;
      return null;
    }
    render(<CreatorDraftsProvider><Probe /></CreatorDraftsProvider>);
    await act(async () => {});

    expect(Object.keys(value).sort()).toEqual(['refresh', 'setWaiting', 'waiting']);
  });

  it('is inert outside the provider rather than throwing', async () => {
    // A badge is not worth crashing a screen over, and MainTabs is rendered on
    // its own by other tests.
    function Probe() {
      const { waiting } = useCreatorDrafts();
      return <Text testID="badge">{String(waiting)}</Text>;
    }
    const view = render(<Probe />);
    expect(badge(view)).toBe('0');
  });
});
