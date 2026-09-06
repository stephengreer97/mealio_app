// MEAL-217. The switches, and the two rules that make them honest.
//
// Before this ticket Mealio sent nothing at all — sendPushToUsers had no
// production callers — and the only control was one switch whose off state was
// a SecureStore boolean. (That switch did reach the server, by revoking the
// device token; what did not exist was any way to say yes to one KIND of
// notification and no to another.)
//
// Two rules are pinned here because both fail silently if broken:
//   ABSENT MEANS ON. Every account predates the column, so reading a missing
//   preference as "off" would ship the feature to nobody and look like a
//   broken sender.
//   THE CATEGORIES COME FROM THE SERVER. A list baked into the app goes stale
//   the moment a build ships.
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => {
  const RealReact = jest.requireActual('react');
  const { View: RealView } = jest.requireActual('react-native');
  return {
    SafeAreaView: ({ children, ...rest }: any) => RealReact.createElement(RealView, rest, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// `mock`-prefixed so jest.mock's factory may reference them.
const mockGetPrefs = jest.fn();
const mockSetPref = jest.fn();
jest.mock('../../src/lib/api', () => ({
  account: {
    notificationPrefs: (...a: unknown[]) => mockGetPrefs(...a),
    setNotificationPref: (...a: unknown[]) => mockSetPref(...a),
  },
}));

import NotificationSettingsSheet from '../../src/components/NotificationSettingsSheet';

const CATEGORIES = [
  { id: 'broadcast', label: 'News from Mealio', description: 'Occasional announcements.' },
  { id: 'creator_draft', label: 'Your recipes', description: 'When a recipe needs a look.' },
];

const open = async (prefs: Record<string, boolean>, categories = CATEGORIES) => {
  mockGetPrefs.mockResolvedValue({ prefs, categories });
  const view = render(<NotificationSettingsSheet visible onClose={() => {}} />);
  await waitFor(() => expect(view.queryByTestId('notif-loading')).toBeNull());
  return view;
};

beforeEach(() => {
  mockGetPrefs.mockReset();
  mockSetPref.mockReset();
  mockSetPref.mockImplementation(async (patch: Record<string, boolean>) => ({ ok: true, prefs: patch }));
});

describe('what the screen offers', () => {
  it('renders the categories the SERVER named, not a hard-coded list', async () => {
    const view = await open({}, [
      { id: 'something_new', label: 'A brand new kind', description: 'Shipped without an app release.' },
    ]);
    expect(view.queryByText('A brand new kind')).toBeTruthy();
    // The categories this build happens to know about are not assumed.
    expect(view.queryByText('News from Mealio')).toBeNull();
  });

  it('says so plainly when there is nothing to choose', async () => {
    const view = await open({}, []);
    expect(view.queryByTestId('notif-empty')).toBeTruthy();
  });
});

describe('absent means on', () => {
  it('shows a category with no stored preference as ON', async () => {
    // The load-bearing default. Reading absent as off would mean the first
    // notification Mealio ever sends reaches nobody.
    const view = await open({});
    expect(view.getByTestId('notif-toggle-broadcast').props.value).toBe(true);
  });

  it('shows one the user turned off as OFF', async () => {
    const view = await open({ broadcast: false });
    expect(view.getByTestId('notif-toggle-broadcast').props.value).toBe(false);
    expect(view.getByTestId('notif-toggle-creator_draft').props.value).toBe(true);
  });
});

describe('turning one off', () => {
  it('sends only the switch that changed', async () => {
    // The server merges. Sending the whole object would race itself: two
    // toggles in quick succession and the second, built from unconfirmed state,
    // reverts the first.
    const view = await open({});
    await act(async () => { fireEvent(view.getByTestId('notif-toggle-broadcast'), 'valueChange', false); });
    expect(mockSetPref).toHaveBeenCalledWith({ broadcast: false });
  });

  it('puts the switch back if the save fails', async () => {
    // Leaving it where the user flicked it would display a setting that is not
    // the one in force, which is worse than an error.
    mockSetPref.mockRejectedValue(new Error('offline'));
    const view = await open({});
    await act(async () => { fireEvent(view.getByTestId('notif-toggle-broadcast'), 'valueChange', false); });
    await waitFor(() => expect(view.queryByTestId('notif-error')).toBeTruthy());
    expect(view.getByTestId('notif-toggle-broadcast').props.value).toBe(true);
  });
});

describe('the master switch', () => {
  it('disables the rows without hiding what you chose', async () => {
    // Stored separately from the per-category flags, so turning it back on
    // restores individual choices instead of flattening them — which is only
    // believable if the rows still SHOW those choices while it is off.
    const view = await open({ all: false, broadcast: false });
    expect(view.getByTestId('notif-toggle-all').props.value).toBe(false);
    expect(view.getByTestId('notif-toggle-creator_draft').props.disabled).toBe(true);
    // Still says what was picked.
    expect(view.getByTestId('notif-toggle-broadcast').props.value).toBe(false);
    expect(view.getByTestId('notif-toggle-creator_draft').props.value).toBe(true);
  });

  it('leaves the rows usable when it is on', async () => {
    const view = await open({});
    expect(view.getByTestId('notif-toggle-broadcast').props.disabled).toBe(false);
  });
});

// ── When this device cannot receive anything ────────────────────────────────
//
// Stephen: "are we expecting the notifications page in Account settings to have
// nothing in it?" No. Every account has at least "News from Mealio". What was
// happening is that the LINK to this sheet was gated on `pushStatus === 'on'`,
// and his device is `unregistered` -- the OS said yes and no token could be
// obtained, because the build has no FCM credentials.
//
// `unregistered` is not a preference, it is a FAILURE. Gating on `on` alone
// meant every Android user, on every build without FCM, could not see this
// feature at all: not their categories, not what they had chosen, not that it
// exists. The choices are per ACCOUNT, they store fine, and they apply the
// moment a token arrives, so hiding it bought nothing but invisibility.
//
// It does have to SAY so, though, or it is a screen of switches that silently
// do nothing on the device you are holding.
describe('a device that cannot receive yet', () => {
  const openUndeliverable = async () => {
    mockGetPrefs.mockResolvedValue({ prefs: {}, categories: CATEGORIES });
    const view = render(<NotificationSettingsSheet visible onClose={() => {}} deliverable={false} />);
    await waitFor(() => expect(view.queryByTestId('notif-loading')).toBeNull());
    return view;
  };

  it('says nothing will reach it', async () => {
    const view = await openUndeliverable();
    expect(view.queryByTestId('notif-undeliverable')).toBeTruthy();
  });

  it('still shows the categories, because the choices are per account', async () => {
    const view = await openUndeliverable();
    expect(view.queryByTestId(`notif-row-${CATEGORIES[0].id}`)).toBeTruthy();
  });

  it('still lets them be changed, so a choice made now applies later', async () => {
    const view = await openUndeliverable();
    await act(async () => {
      fireEvent(view.getByTestId(`notif-toggle-${CATEGORIES[0].id}`), 'valueChange', false);
    });
    expect(mockSetPref).toHaveBeenCalledWith({ [CATEGORIES[0].id]: false });
  });

  it('says NOTHING of the sort when the device is fine', async () => {
    // The notice has to be absent in the normal case, or it is permanent
    // furniture that everyone learns to ignore.
    const view = await open({}, CATEGORIES);
    expect(view.queryByTestId('notif-undeliverable')).toBeNull();
  });
});
