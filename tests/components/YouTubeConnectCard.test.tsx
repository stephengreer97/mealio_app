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
// The fourth is the one the mobile port adds: connecting leaves the app and
// disconnecting does not. Google will not show its consent screen in an embedded
// WebView and the callback lands on the website, so connecting opens the portal;
// revocation must never depend on a browser round trip.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  const icon = (props: any) => RealReact.createElement(RealText, null, props.name);
  return { Ionicons: icon, Feather: icon, MaterialIcons: icon };
});

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'dismiss' })) }));

jest.mock('../../src/lib/api', () => ({
  creators: {
    youtube: {
      status: jest.fn(),
      setAppendOptIn: jest.fn(async (appendOptIn: boolean) => ({ ok: true, appendOptIn })),
      disconnect: jest.fn(async () => ({ ok: true })),
    },
  },
}));

import YouTubeConnectCard from '../../src/components/YouTubeConnectCard';
import { creators as creatorsApi } from '../../src/lib/api';

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
  appendOptIn: false,
};

const CONSENT_LABEL = /Let Mealio add the Mealio link to a video’s description/i;

beforeEach(() => {
  status.mockReset();
  setAppendOptIn.mockReset();
  disconnect.mockReset();
  setAppendOptIn.mockImplementation(async (appendOptIn: boolean) => ({ ok: true, appendOptIn }));
  disconnect.mockResolvedValue({ ok: true });
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
    // The requirement, and the reason for it: this asks permission to edit a
    // video description. Offering that over a channel that does not exist is
    // noise at best, and at worst it trains someone to tap past a permission
    // prompt. A creator who starts a channel later adds the link in the links
    // card and this appears.
    const r = await show({
      hasChannel: false,
      connected: false,
      channel: null,
      brokenReason: null,
      canWriteDescriptions: false,
      appendOptIn: false,
    });
    await waitFor(() => expect(r.toJSON()).toBeNull());
    expect(r.queryByText(CONSENT_LABEL)).toBeNull();
  });

  it('appears for a creator who has a link but has not connected yet', async () => {
    // `hasChannel` is broader than `connected`: a link the creator gave us says
    // a channel exists before a grant does, and that is the creator who needs
    // the connect route offered to them.
    const r = await show({
      hasChannel: true,
      connected: false,
      channel: null,
      brokenReason: null,
      canWriteDescriptions: false,
      appendOptIn: false,
    });
    expect(r.getByText('Connect your channel')).toBeTruthy();
    expect(r.getByText(CONSENT_LABEL)).toBeTruthy();
  });

  it('renders nothing when the status could not be read', async () => {
    // Guessing means either inventing a connection or denying a real one. Both
    // are worse than the card not being there this once.
    status.mockRejectedValue(new Error('offline'));
    const r = render(<YouTubeConnectCard />);
    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(r.toJSON()).toBeNull();
  });
});

describe('YouTubeConnectCard — the setting is off unless turned on', () => {
  it('is off on a fresh healthy connection', async () => {
    const r = await show(CONNECTED);
    expect(r.getByLabelText(/Let Mealio add the Mealio link/i).props.accessibilityState.checked).toBe(false);
    // Nothing is written just by looking at the card.
    expect(setAppendOptIn).not.toHaveBeenCalled();
  });

  it('is off when the server does not mention it at all', async () => {
    // A missing flag is not a granted one. The server sends
    // `youtube_append_opt_in === true`, so anything else — absent, null, the
    // string "false" — has to read as off.
    const r = await show({ ...CONNECTED, appendOptIn: undefined });
    expect(r.getByLabelText(/Let Mealio add the Mealio link/i).props.accessibilityState.checked).toBe(false);
  });

  it('shows it on for a creator who has already granted it', async () => {
    // The other direction of the same rule: a granted permission shown as off
    // both misreports it and invites the creator to "turn on" what is already on.
    const r = await show({ ...CONNECTED, appendOptIn: true });
    expect(r.getByLabelText(/Let Mealio add the Mealio link/i).props.accessibilityState.checked).toBe(true);
  });

  it('says plainly that it edits the video description', async () => {
    // The copy is the consent. "Add the Mealio link to a video's description" is
    // what actually happens, and a gentler phrasing would be asking for
    // permission to do something other than the thing being done.
    const r = await show(CONNECTED);
    expect(r.getByText(CONSENT_LABEL)).toBeTruthy();
    expect(r.getByText(/Only for videos a Mealio recipe came from/i)).toBeTruthy();
    expect(r.getByText(/Left off, nothing on your channel is ever edited/i)).toBeTruthy();
  });
});

describe('YouTubeConnectCard — turning it on and off', () => {
  it('turns on through the server, and shows the answer rather than the request', async () => {
    const r = await show(CONNECTED);
    fireEvent.press(r.getByLabelText(/Let Mealio add the Mealio link/i));

    await waitFor(() => expect(setAppendOptIn).toHaveBeenCalledWith(true));
    await waitFor(() =>
      expect(r.getByLabelText(/Let Mealio add the Mealio link/i).props.accessibilityState.checked).toBe(true),
    );
  });

  it('does not show consent as granted when the server refused to store it', async () => {
    // The one direction of optimism this switch cannot afford. Showing it on
    // after a failed write tells a creator they have permitted something they
    // have not, and the appends never come.
    setAppendOptIn.mockRejectedValue(new Error('This connection was granted without permission to edit descriptions. Reconnect YouTube to allow it.'));
    const r = await show(CONNECTED);
    fireEvent.press(r.getByLabelText(/Let Mealio add the Mealio link/i));

    await waitFor(() => expect(r.getByText(/Reconnect YouTube to allow it/i)).toBeTruthy());
    expect(r.getByLabelText(/Let Mealio add the Mealio link/i).props.accessibilityState.checked).toBe(false);
  });

  it('turns off even while the connection is broken', async () => {
    // Revocation has to work from every state there is. A creator whose grant
    // has broken is exactly the one most likely to want it withdrawn, and
    // reconnecting first is the thing that is failing.
    const r = await show({ ...CONNECTED, brokenReason: 'the refresh token was revoked.', appendOptIn: true });
    expect(r.getByLabelText(/Let Mealio add the Mealio link/i).props.accessibilityState.disabled).toBe(false);

    fireEvent.press(r.getByLabelText(/Let Mealio add the Mealio link/i));
    await waitFor(() => expect(setAppendOptIn).toHaveBeenCalledWith(false));
  });

  it('cannot be turned on without a connection, and says why before the tap', async () => {
    // The route refuses it either way. Saying so up front beats letting the
    // creator tap a switch that answers with an error.
    const r = await show({
      hasChannel: true,
      connected: false,
      channel: null,
      brokenReason: null,
      canWriteDescriptions: false,
      appendOptIn: false,
    });
    expect(r.getByLabelText(/Let Mealio add the Mealio link/i).props.accessibilityState.disabled).toBe(true);
    expect(r.getByText(/Connect your channel before turning this on/i)).toBeTruthy();

    fireEvent.press(r.getByLabelText(/Let Mealio add the Mealio link/i));
    expect(setAppendOptIn).not.toHaveBeenCalled();
  });

  it('cannot be turned on over a grant made without the write scope', async () => {
    const r = await show({ ...CONNECTED, canWriteDescriptions: false });
    expect(r.getByLabelText(/Let Mealio add the Mealio link/i).props.accessibilityState.disabled).toBe(true);
    expect(r.getByText(/without permission to edit descriptions. Reconnect YouTube/i)).toBeTruthy();
  });

  it('can still be turned off over a grant made without the write scope', async () => {
    // The lock is only ever on the "on" direction. A creator who granted this
    // and then reconnected without the scope must still be able to withdraw it.
    const r = await show({ ...CONNECTED, canWriteDescriptions: false, appendOptIn: true });
    expect(r.getByLabelText(/Let Mealio add the Mealio link/i).props.accessibilityState.disabled).toBe(false);

    fireEvent.press(r.getByLabelText(/Let Mealio add the Mealio link/i));
    await waitFor(() => expect(setAppendOptIn).toHaveBeenCalledWith(false));
  });
});

describe('YouTubeConnectCard — connecting leaves the app, disconnecting does not', () => {
  it('opens the web portal to connect, then re-reads what happened there', async () => {
    // Google refuses its consent screen in an embedded WebView, and the callback
    // redirects to mealio.co/creator with no deep link back. So the flow runs
    // where it already ends, and the card asks the server what came of it rather
    // than reading anything out of the browser.
    const openWeb = jest.fn(async () => ({ type: 'dismiss' }));
    const r = await show({ ...CONNECTED, connected: false, channel: null }, { openWeb });

    fireEvent.press(r.getByText('Connect YouTube on the web'));
    await waitFor(() => expect(openWeb).toHaveBeenCalledWith('https://mealio.co/creator'));
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
  });

  it('explains why connecting is not in the app', async () => {
    const r = await show({ ...CONNECTED, connected: false, channel: null });
    expect(r.getByText(/Google will not show its permission screen inside an app/i)).toBeTruthy();
  });

  it('offers reconnection on a broken grant without hiding the connection', async () => {
    // A broken grant is still a connection: the consent on it is real and
    // revocable. Rendering it as if nothing were connected would show a granted
    // permission as off and offer no way to withdraw it.
    const r = await show({ ...CONNECTED, brokenReason: 'the refresh token was revoked.' });
    expect(r.getByText(/Your YouTube connection stopped working/i)).toBeTruthy();
    expect(r.getByText('Connect YouTube on the web')).toBeTruthy();
    expect(r.getByText('Disconnect YouTube')).toBeTruthy();
  });

  it('disconnects in the app, and only says so once the server has', async () => {
    // One authenticated DELETE, no redirect. "Your channel is disconnected" is
    // the last thing a creator will check up on, so the card re-reads rather
    // than assuming — and revocation never depends on a browser round trip.
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => {
      buttons.find((b: any) => b.text === 'Disconnect').onPress();
    });
    const r = await show(CONNECTED);

    fireEvent.press(r.getByText('Disconnect YouTube'));
    await waitFor(() => expect(disconnect).toHaveBeenCalled());
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
  });

  it('does not claim a disconnect the server refused', async () => {
    disconnect.mockRejectedValue(
      new Error('We could not disconnect that channel. Nothing was changed — please try again.'),
    );
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => {
      buttons.find((b: any) => b.text === 'Disconnect').onPress();
    });
    const r = await show(CONNECTED);

    fireEvent.press(r.getByText('Disconnect YouTube'));
    await waitFor(() => expect(r.getByText(/Nothing was changed — please try again/i)).toBeTruthy());
    // Still connected on screen, because it still is.
    expect(r.getByText("Sarah's Kitchen")).toBeTruthy();
  });

  it('offers no disconnect to a creator who never connected', async () => {
    const r = await show({ ...CONNECTED, connected: false, channel: null });
    expect(r.queryByText('Disconnect YouTube')).toBeNull();
  });
});
