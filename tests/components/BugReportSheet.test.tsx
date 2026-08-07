// What a bug report actually puts on the wire (MEAL-142), and what a sign-out
// has to take off it.
//
// These are the only tests that can cover either. `BugReportInput.context` is
// `Record<string, unknown>` (lib/api.ts), and the website iterates whatever keys
// arrive with no schema on its side (mealio_central lib/email.ts) — so the
// compiler checks nothing about these key names, and a typo'd key still renders
// a perfectly plausible row in the support inbox. The key names ARE the contract,
// so they are pinned here as literals: if one of these assertions fails, the fix
// is to check what the website reads, not to update the literal.
//
// The sign-out case is a privacy test, not a plumbing one. The log buffer keeps
// product names and cart contents on purpose (lib/logBuffer), and the last cart
// run is this account's shopping activity. Both are in memory only, so both used
// to outlive a sign-out — meaning on a shared phone the previous person's cart
// could be attached to the next person's report, under the next person's
// verified userId.

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, Text, TouchableOpacity } from 'react-native';

// ── Module mocks ─────────────────────────────────────────────────────────────

/** In-memory keychain, shared across a test file on purpose: it is "the device". */
const mockKeychain = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockKeychain.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockKeychain.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockKeychain.delete(k); }),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '9.9.9' } },
}));

jest.mock('../../src/lib/api', () => ({
  bugReport: { submit: jest.fn(async () => ({ ok: true })) },
  auth: {
    login: jest.fn(),
    logout: jest.fn(async () => ({ ok: true })),
    verify: jest.fn(async () => { throw new Error('no session'); }),
    renew: jest.fn(async () => ({})),
    verify2FA: jest.fn(),
  },
  creators: { getMe: jest.fn(async () => ({ creator: null })) },
  usage: { logOpen: jest.fn(async () => {}) },
}));

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
}));

jest.mock('../../src/lib/push', () => ({
  unregisterDevice: jest.fn(async () => {}),
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

import BugReportSheet from '../../src/components/BugReportSheet';
import { AuthProvider, useAuth } from '../../src/context/AuthContext';
import { bugReport, auth } from '../../src/lib/api';
import { clearSessionLogs, getSessionLogs, installConsoleCapture } from '../../src/lib/logBuffer';
import { clearLastAutomationRun, setLastAutomationRun } from '../../src/lib/lastAutomationRun';

const submit = bugReport.submit as jest.Mock;
const login = auth.login as jest.Mock;

/** The context object the sheet sent on its most recent submit. */
function sentContext(): Record<string, unknown> {
  expect(submit).toHaveBeenCalled();
  return submit.mock.calls[submit.mock.calls.length - 1][0].context;
}

/** What the sheet sent as the attached session logs. */
function sentLogs(): string {
  expect(submit).toHaveBeenCalled();
  return submit.mock.calls[submit.mock.calls.length - 1][0].logs ?? '';
}

/**
 * The sheet as it is really mounted — inside the auth provider, with a route
 * name, the way HelpScreen mounts it. The buttons stand in for a sign-in screen
 * and the account screen's Log Out.
 */
function Harness() {
  const { user, login: doLogin, logout } = useAuth();
  return (
    <>
      <Text testID="who">{user?.id ?? 'signed-out'}</Text>
      <TouchableOpacity testID="login-a" onPress={() => { void doLogin('a@example.com', 'pw'); }}>
        <Text>login A</Text>
      </TouchableOpacity>
      <TouchableOpacity testID="login-b" onPress={() => { void doLogin('b@example.com', 'pw'); }}>
        <Text>login B</Text>
      </TouchableOpacity>
      <TouchableOpacity testID="logout" onPress={() => { void logout(); }}>
        <Text>log out</Text>
      </TouchableOpacity>
      <BugReportSheet visible onClose={() => {}} currentRoute="Help" />
    </>
  );
}

async function renderSheet() {
  const utils = render(
    <AuthProvider>
      <Harness />
    </AuthProvider>,
  );
  // Let AuthProvider's initAuth settle so its state updates don't land mid-test.
  await act(async () => { await Promise.resolve(); });
  return utils;
}

/** Describe a problem and press Send, then wait for the submit to land. */
async function fileReport(utils: Awaited<ReturnType<typeof renderSheet>>, text = 'cart add did nothing') {
  fireEvent.changeText(utils.getByPlaceholderText(/Describe the problem/i), text);
  await act(async () => {
    fireEvent.press(utils.getByText('Send report'));
  });
  await waitFor(() => expect(submit).toHaveBeenCalled());
}

beforeAll(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  // The only way anything reaches the ring buffer is through console.
  installConsoleCapture();
});

beforeEach(() => {
  submit.mockClear();
  submit.mockResolvedValue({ ok: true });
  login.mockReset();
  mockKeychain.clear();
  clearSessionLogs();
  clearLastAutomationRun();
});

// ── The keys on the wire ─────────────────────────────────────────────────────

describe('a bug report names the last cart run', () => {
  it('sends the run id, the store and a readable age under the agreed keys', async () => {
    // Pinned clock: the age is asserted exactly, and the sheet reads Date.now()
    // at submit-press, which is however many ms after the setup line ran.
    const t0 = 1_700_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);
    setLastAutomationRun('run-x', 'heb', t0 - 4_000);
    const utils = await renderSheet();
    await fileReport(utils);
    clock.mockRestore();

    const ctx = sentContext();
    expect(ctx.lastCartRunId).toBe('run-x');
    expect(ctx.lastCartRunStore).toBe('heb');
    // A phrase, not a millisecond count: the website renders String(v) with no
    // formatting hook, so an unformatted age arrives as a nine-digit integer.
    expect(ctx.lastCartRunAge).toBe('4s ago');

    // The keys the website has always read must still be there.
    expect(ctx.route).toBe('Help');
    expect(ctx.appVersion).toBe('9.9.9');
  });

  it('sends no millisecond age — the run row carries its own timestamp', async () => {
    setLastAutomationRun('run-x', 'heb');
    const utils = await renderSheet();
    await fileReport(utils);
    expect(Object.keys(sentContext())).not.toContain('lastCartRunAgeMs');
  });

  it('sends the keys as null when this session never ran a cart', async () => {
    const utils = await renderSheet();
    await fileReport(utils);

    const ctx = sentContext();
    expect(ctx.lastCartRunId).toBeNull();
    expect(ctx.lastCartRunStore).toBeNull();
    expect(ctx.lastCartRunAge).toBeNull();
  });

  it('names the most recent run when the session ran carts at two stores', async () => {
    setLastAutomationRun('run-heb', 'heb', Date.now() - 60_000);
    setLastAutomationRun('run-wmt', 'walmart', Date.now() - 1_000);
    const utils = await renderSheet();
    await fileReport(utils);

    expect(sentContext()).toMatchObject({
      lastCartRunId: 'run-wmt',
      lastCartRunStore: 'walmart',
    });
  });
});

// ── The privacy boundary at sign-out ─────────────────────────────────────────

describe('signing out clears what the next account must not send', () => {
  function asUser(id: string) {
    login.mockResolvedValue({ accessToken: `token-${id}`, user: { id, email: `${id}@example.com` } });
  }

  it('does not attach the previous account cart or run to the next account report', async () => {
    const utils = await renderSheet();

    // User A signs in and adds a cart, which puts product names in the buffer.
    asUser('user-A');
    await act(async () => { fireEvent.press(utils.getByTestId('login-a')); });
    await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('user-A'));
    console.log('[Cart] added Kirkland Prenatal Vitamins to cart');
    setLastAutomationRun('run-belongs-to-A', 'heb');
    expect(getSessionLogs()).toContain('Kirkland Prenatal Vitamins');

    // A hands the phone over.
    await act(async () => { fireEvent.press(utils.getByTestId('logout')); });
    await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('signed-out'));

    asUser('user-B');
    await act(async () => { fireEvent.press(utils.getByTestId('login-b')); });
    await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('user-B'));

    await fileReport(utils, 'the app will not load my meals');

    // Filed by B, and carrying nothing of A's.
    expect(sentContext().userId).toBe('user-B');
    expect(sentLogs()).not.toContain('Kirkland Prenatal Vitamins');
    expect(sentContext().lastCartRunId).toBeNull();
    expect(sentContext().lastCartRunStore).toBeNull();
  });

  it('keeps the run for the account that made it, so a normal report still joins', async () => {
    const utils = await renderSheet();
    asUser('user-A');
    await act(async () => { fireEvent.press(utils.getByTestId('login-a')); });
    await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('user-A'));

    console.log('[Cart] added Sour Cream to cart');
    setLastAutomationRun('run-belongs-to-A', 'heb');
    await fileReport(utils, 'sour cream never made it into the cart');

    expect(sentContext().lastCartRunId).toBe('run-belongs-to-A');
    expect(sentLogs()).toContain('Sour Cream');
  });
});
