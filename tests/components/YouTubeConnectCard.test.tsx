// The YouTube description-append setting on mobile (MEAL-74 / MEAL-78).
//
// This is consent to **write** to somebody else's property: to edit the
// description of a video the creator published. Three things follow from that,
// and they are what these tests hold down.
//
//   • It is off unless turned on. Never seeded from `true`, never assumed from a
//     request that has not come back.
//   • It is not shown at all to a creator with no YouTube channel. Hidden, not
//     disabled — a permission prompt about a channel that does not exist is one
//     a creator learns to tap past, which is what makes the next one worthless.
//   • Turning it off works from every state there is, including a connection
//     that has broken. A switch that only flips one way is not revocation.
//
// The fourth is how connecting works on a phone: the consent screen runs in the
// system browser through `openAuthSessionAsync`, the server hands the result
// back to `mealio://creator/connect`, and the app exchanges the code with
// `POST /api/creator/youtube/complete`. Disconnecting is one DELETE, no browser.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  const icon = (props: any) => RealReact.createElement(RealText, null, props.name);
  return { Ionicons: icon, Feather: icon, MaterialIcons: icon };
});

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn(async () => ({ type: 'dismiss' })) }));

jest.mock('../../src/lib/api', () => ({
  creators: {
    youtube: {
      status: jest.fn(),
      setAppendOptIn: jest.fn(async (appendOptIn: boolean) => ({ ok: true, appendOptIn })),
      disconnect: jest.fn(async () => ({ ok: true })),
    },
    connections: {
      start: jest.fn(async () => ({ url: 'https://accounts.google.test/o/oauth2?x=1' })),
      complete: jest.fn(async () => ({ ok: true, outcome: 'connected' })),
    },
  },
}));

import * as WebBrowser from 'expo-web-browser';
import { ApiError } from '../../src/lib/authErrors';
import YouTubeConnectCard from '../../src/components/YouTubeConnectCard';
import { creators as creatorsApi } from '../../src/lib/api';

const openAuth = WebBrowser.openAuthSessionAsync as unknown as jest.Mock;
const start = creatorsApi.connections.start as unknown as jest.Mock;
const complete = creatorsApi.connections.complete as unknown as jest.Mock;

const status = creatorsApi.youtube.status as unknown as jest.Mock;
const setAppendOptIn = creatorsApi.youtube.setAppendOptIn as unknown as jest.Mock;
const disconnect = creatorsApi.youtube.disconnect as unknown as jest.Mock;

/** A healthy connection with the write scope and the setting still off. */
const CONNECTED = {
  hasChannel: true,
  connected: true,
  channel: { id: 'UC1', title: "Sarah's Kitchen" },
  brokenReason: null,
  canWriteDescriptions: true,
  canReadCaptions: true,
  appendOptIn: false,
};

const NOT_CONNECTED = {
  hasChannel: true,
  connected: false,
  channel: null,
  brokenReason: null,
  canWriteDescriptions: false,
  canReadCaptions: false,
  appendOptIn: false,
};

const CONSENT_LABEL = /Let Mealio add the Mealio link to a video’s description/i;

beforeEach(() => {
  status.mockReset();
  setAppendOptIn.mockReset();
  disconnect.mockReset();
  setAppendOptIn.mockImplementation(async (appendOptIn: boolean) => ({ ok: true, appendOptIn }));
  disconnect.mockResolvedValue({ ok: true });
  openAuth.mockReset();
  openAuth.mockResolvedValue({ type: 'dismiss' });
  start.mockReset();
  start.mockResolvedValue({ url: 'https://accounts.google.test/o/oauth2?x=1' });
  complete.mockReset();
  complete.mockResolvedValue({ ok: true, outcome: 'connected' });
});

afterEach(() => jest.restoreAllMocks());

/**
 * Renders and waits for the card to have settled.
 *
 * MEAL-113. This used to wait only for `expect(status).toHaveBeenCalled()`, which
 * is the wrong thing: the mount effect calls `status()` synchronously, so that is
 * already true on the first check — before the answer exists. The card renders
 * null while `loading`, and every assertion after `show()` reads the render the
 * answer produces, so the helper was handing back a card that had not loaded yet
 * and the assertions were racing the commit.
 *
 * It passed anyway because `mockResolvedValue` lands inside the single
 * `setImmediate` that waitFor's `wrapAsync` flushes on its way out. That margin
 * is one macrotask wide. Make the answer arrive a macrotask later — which is what
 * a real request does — and the card is still loading 36 times in 40. That is the
 * flake that failed CI on a documentation-only PR: not a bad assertion, a helper
 * that did not wait for what the assertions read.
 *
 * So wait for the answer to be on screen, not for the request to have left.
 * `waitFor` polls on real timers, so it is indifferent to how many turns the
 * answer takes. A creator with a channel always renders something once `loading`
 * clears; the no-channel case renders null settled or not, so there is nothing to
 * wait for there and its own test asserts the null directly.
 */
async function show(next: any, props: any = {}) {
  status.mockResolvedValue(next);
  const r = render(<YouTubeConnectCard {...props} />);
  await waitFor(() => expect(status).toHaveBeenCalled());
  if (next?.hasChannel) await waitFor(() => expect(r.toJSON()).not.toBeNull());
  return r;
}

describe('YouTubeConnectCard — who is shown the setting at all', () => {
  it('renders nothing for a creator with no YouTube channel', async () => {
    // Standalone, a permission prompt about a channel that does not exist is
    // one a creator learns to tap past.
    const r = await show({ ...NOT_CONNECTED, hasChannel: false });
    await waitFor(() => expect(r.toJSON()).toBeNull());
    expect(r.queryByText(CONSENT_LABEL)).toBeNull();
  });

  it('is shown embedded even without a channel link, because the creator just picked YouTube', async () => {
    const r = await show({ ...NOT_CONNECTED, hasChannel: false }, { embedded: true });
    await waitFor(() => expect(r.getByText('Connect your channel')).toBeTruthy());
    expect(r.getByText('Connect YouTube')).toBeTruthy();
  });

  it('appears for a creator who has a link but has not connected yet', async () => {
    const r = await show(NOT_CONNECTED);
    expect(r.getByText('Connect your channel')).toBeTruthy();
    expect(r.getByText(CONSENT_LABEL)).toBeTruthy();
  });

  it('renders nothing when the status could not be read', async () => {
    status.mockRejectedValue(new Error('offline'));
    const r = render(<YouTubeConnectCard />);
    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(r.toJSON()).toBeNull();
  });

  it('tells the section whether a usable channel is connected', async () => {
    const onConnectionChange = jest.fn();
    await show({ ...CONNECTED, brokenReason: 'revoked.' }, { onConnectionChange });
    await waitFor(() => expect(onConnectionChange).toHaveBeenCalledWith(false));
  });
});

describe('YouTubeConnectCard — the setting is off unless turned on', () => {
  it('is off on a fresh healthy connection', async () => {
    const r = await show(CONNECTED);
    expect(r.getByLabelText(/Let Mealio add the Mealio link/i).props.accessibilityState.checked).toBe(false);
    expect(setAppendOptIn).not.toHaveBeenCalled();
  });

  it('is off when the server does not mention it at all', async () => {
    const r = await show({ ...CONNECTED, appendOptIn: undefined });
    expect(r.getByLabelText(/Let Mealio add the Mealio link/i).props.accessibilityState.checked).toBe(false);
  });

  it('shows it on for a creator who has already granted it', async () => {
    const r = await show({ ...CONNECTED, appendOptIn: true });
    expect(r.getByLabelText(/Let Mealio add the Mealio link/i).props.accessibilityState.checked).toBe(true);
  });

  it('says plainly that it edits the video description', async () => {
    const r = await show(CONNECTED);
    expect(r.getByText(CONSENT_LABEL)).toBeTruthy();
    expect(r.getByText(/Only for videos a Mealio recipe came from/i)).toBeTruthy();
    expect(r.getByText(/It does not remove the permission from your Google Account/i)).toBeTruthy();
  });
});

describe('YouTubeConnectCard — turning it on and off', () => {
  it('turns on through the server, shows the answer and says so', async () => {
    const r = await show(CONNECTED);
    fireEvent.press(r.getByLabelText(/Let Mealio add the Mealio link/i));

    await waitFor(() => expect(setAppendOptIn).toHaveBeenCalledWith(true));
    await waitFor(() =>
      expect(r.getByLabelText(/Let Mealio add the Mealio link/i).props.accessibilityState.checked).toBe(true),
    );
    expect(r.getByTestId('append-just-enabled')).toBeTruthy();
  });

  it('does not show consent as granted when the server refused to store it', async () => {
    setAppendOptIn.mockRejectedValue(new ApiError(500, 'Could not store that.'));
    const r = await show(CONNECTED);
    fireEvent.press(r.getByLabelText(/Let Mealio add the Mealio link/i));

    await waitFor(() => expect(r.getByText('Could not store that.')).toBeTruthy());
    expect(r.getByLabelText(/Let Mealio add the Mealio link/i).props.accessibilityState.checked).toBe(false);
  });

  it('turns off even while the connection is broken', async () => {
    const r = await show({ ...CONNECTED, brokenReason: 'the refresh token was revoked.', appendOptIn: true });
    expect(r.getByLabelText(/Let Mealio add the Mealio link/i).props.accessibilityState.disabled).toBe(false);

    fireEvent.press(r.getByLabelText(/Let Mealio add the Mealio link/i));
    await waitFor(() => expect(setAppendOptIn).toHaveBeenCalledWith(false));
  });

  it('before connecting, the tick is local and travels with the connect request', async () => {
    const r = await show(NOT_CONNECTED);
    fireEvent.press(r.getByLabelText(/Let Mealio add the Mealio link/i));
    expect(setAppendOptIn).not.toHaveBeenCalled();
    expect(r.getByText('Connect YouTube and edit descriptions')).toBeTruthy();

    fireEvent.press(r.getByText('Connect YouTube and edit descriptions'));
    await waitFor(() => expect(start).toHaveBeenCalledWith('youtube', { appendOptIn: true }));
  });

  it('a tick over a read-only grant becomes a consent trip for the write scope', async () => {
    // The server answers 409 needsConsent; ticking the box is the request.
    setAppendOptIn.mockRejectedValue(
      new ApiError(409, 'This connection has not been given permission to edit descriptions yet.', { needsConsent: true }),
    );
    const r = await show({ ...CONNECTED, canWriteDescriptions: false, canReadCaptions: false });
    fireEvent.press(r.getByLabelText(/Let Mealio add the Mealio link/i));
    await waitFor(() => expect(start).toHaveBeenCalledWith('youtube', { appendOptIn: true }));
    expect(openAuth).toHaveBeenCalled();
  });
});

describe('YouTubeConnectCard — connecting in the app', () => {
  it('runs the consent screen and completes with the code and state it came back with', async () => {
    openAuth.mockResolvedValue({
      type: 'success',
      url: 'mealio://creator/connect?platform=youtube&code=4%2F0Ab&state=signed.state',
    });
    const onConnected = jest.fn();
    const r = await show(NOT_CONNECTED, { onConnected });
    status.mockResolvedValue(CONNECTED);

    fireEvent.press(r.getByText('Connect YouTube'));

    await waitFor(() => expect(complete).toHaveBeenCalledWith('youtube', '4/0Ab', 'signed.state'));
    expect(start).toHaveBeenCalledWith('youtube', { appendOptIn: false });
    expect(openAuth).toHaveBeenCalledWith('https://accounts.google.test/o/oauth2?x=1', 'mealio://creator/connect');
    await waitFor(() => expect(r.getByTestId('youtube-connected')).toBeTruthy());
    expect(r.getByText("Sarah's Kitchen")).toBeTruthy();
    expect(onConnected).toHaveBeenCalled();
  });

  it('says nothing alarming when the browser is closed', async () => {
    openAuth.mockResolvedValue({ type: 'cancel' });
    const r = await show(NOT_CONNECTED);
    fireEvent.press(r.getByText('Connect YouTube'));
    await waitFor(() => expect(openAuth).toHaveBeenCalled());
    await waitFor(() => expect(r.getByText('Connect YouTube')).toBeTruthy());
    expect(complete).not.toHaveBeenCalled();
    expect(r.queryByTestId('youtube-error')).toBeNull();
  });

  it('shows the server’s sentence when the exchange fails', async () => {
    openAuth.mockResolvedValue({ type: 'success', url: 'mealio://creator/connect?platform=youtube&code=c&state=s' });
    complete.mockResolvedValue({
      ok: false,
      outcome: 'failed',
      reason: 'account',
      message: 'That Google account has no YouTube channel we can read.',
    });
    const r = await show(NOT_CONNECTED);
    fireEvent.press(r.getByText('Connect YouTube'));
    await waitFor(() => expect(r.getByTestId('youtube-error')).toBeTruthy());
    expect(r.getByText('That Google account has no YouTube channel we can read.')).toBeTruthy();
  });

  it('asks for captions without answering the editing question', async () => {
    const r = await show({ ...CONNECTED, canReadCaptions: false });
    fireEvent.press(r.getByText('Let Mealio read my captions'));
    await waitFor(() => expect(start).toHaveBeenCalledWith('youtube', { captions: true }));
  });

  it('offers reconnection on a broken grant without hiding the connection', async () => {
    const r = await show({ ...CONNECTED, brokenReason: 'the refresh token was revoked.' });
    expect(r.getByText(/Your YouTube connection stopped working/i)).toBeTruthy();
    expect(r.getByText('Connect YouTube')).toBeTruthy();
    expect(r.getByText('Disconnect YouTube')).toBeTruthy();
  });
});

describe('YouTubeConnectCard — disconnecting', () => {
  it('disconnects in the app, and only says so once the server has', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => {
      buttons.find((b: any) => b.text === 'Disconnect').onPress();
    });
    const r = await show(CONNECTED);

    fireEvent.press(r.getByText('Disconnect YouTube'));
    await waitFor(() => expect(disconnect).toHaveBeenCalled());
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
  });

  it('does not claim a disconnect the server refused', async () => {
    disconnect.mockRejectedValue(new Error('We could not disconnect that channel. Nothing was changed. Please try again.'));
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => {
      buttons.find((b: any) => b.text === 'Disconnect').onPress();
    });
    const r = await show(CONNECTED);

    fireEvent.press(r.getByText('Disconnect YouTube'));
    await waitFor(() => expect(r.getByText(/Nothing was changed. Please try again/i)).toBeTruthy());
    expect(r.getByText("Sarah's Kitchen")).toBeTruthy();
  });

  it('leaves a healthy connection’s disconnect to the sync section when embedded', async () => {
    const r = await show(CONNECTED, { embedded: true });
    expect(r.queryByText('Disconnect YouTube')).toBeNull();
  });

  it('offers no disconnect to a creator who never connected', async () => {
    const r = await show(NOT_CONNECTED);
    expect(r.queryByText('Disconnect YouTube')).toBeNull();
  });
});
