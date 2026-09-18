// Connecting Instagram or TikTok from inside the app.
//
// The round trip under test, with only the system browser and the network
// stubbed: POST /connect {client:'app'} -> openAuthSessionAsync(url,
// 'mealio://creator/connect') -> POST /complete {code, state} -> re-read status.
// And the three ways it can end short of connected, which must read
// differently: the browser closed (say nothing), a no on the platform's own
// screen (say so quietly), or a failure (say the server's sentence).

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  const icon = (props: any) => RealReact.createElement(RealText, null, props.name);
  return { Ionicons: icon, Feather: icon, MaterialIcons: icon };
});

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));

jest.mock('../../src/lib/api', () => ({
  creators: {
    connections: {
      status: jest.fn(),
      disconnect: jest.fn(async () => ({ ok: true })),
      start: jest.fn(),
      complete: jest.fn(),
    },
  },
}));

import * as WebBrowser from 'expo-web-browser';
import { ApiError } from '../../src/lib/authErrors';
import PlatformConnectCard from '../../src/components/PlatformConnectCard';
import { creators as creatorsApi } from '../../src/lib/api';
import { CREATOR_SOURCE_OPTIONS } from '../../src/constants/creatorSources';

const openAuth = WebBrowser.openAuthSessionAsync as unknown as jest.Mock;
const status = creatorsApi.connections.status as unknown as jest.Mock;
const disconnect = creatorsApi.connections.disconnect as unknown as jest.Mock;
const start = creatorsApi.connections.start as unknown as jest.Mock;
const complete = creatorsApi.connections.complete as unknown as jest.Mock;

const NOT_CONNECTED = { connected: false, account: null, brokenReason: null, expiresAt: null, configured: true };
const CONNECTED = { connected: true, account: { id: '1', name: 'chefsarah' }, brokenReason: null, expiresAt: null, configured: true };

beforeEach(() => {
  jest.clearAllMocks();
  status.mockResolvedValue(NOT_CONNECTED);
  start.mockResolvedValue({ url: 'https://www.tiktok.test/v2/auth/authorize?x=1' });
  complete.mockResolvedValue({ ok: true, outcome: 'connected' });
  openAuth.mockResolvedValue({ type: 'dismiss' });
});

afterEach(() => jest.restoreAllMocks());

async function show(props: any) {
  const r = render(<PlatformConnectCard {...props} />);
  await waitFor(() => expect(r.toJSON()).not.toBeNull());
  return r;
}

describe('PlatformConnectCard — the connect round trip', () => {
  it('completes with the code and state and then shows the account as connected', async () => {
    openAuth.mockResolvedValue({
      type: 'success',
      url: 'mealio://creator/connect?platform=tiktok&code=tt-code&state=st%2B1',
    });
    const onConnectionChange = jest.fn();
    const onConnected = jest.fn();
    const r = await show({ platform: 'tiktok', embedded: true, onConnectionChange, onConnected });
    status.mockResolvedValue(CONNECTED);

    fireEvent.press(r.getByText('Connect TikTok'));

    await waitFor(() => expect(complete).toHaveBeenCalledWith('tiktok', 'tt-code', 'st+1'));
    expect(start).toHaveBeenCalledWith('tiktok', {});
    expect(openAuth).toHaveBeenCalledWith('https://www.tiktok.test/v2/auth/authorize?x=1', 'mealio://creator/connect');
    await waitFor(() => expect(r.getByTestId('tiktok-connected')).toBeTruthy());
    expect(r.getByText('@chefsarah')).toBeTruthy();
    expect(onConnectionChange).toHaveBeenLastCalledWith(true);
    expect(onConnected).toHaveBeenCalled();
  });

  it('says nothing at all when the creator closes the browser', async () => {
    openAuth.mockResolvedValue({ type: 'dismiss' });
    const r = await show({ platform: 'tiktok', embedded: true });
    fireEvent.press(r.getByText('Connect TikTok'));
    await waitFor(() => expect(openAuth).toHaveBeenCalled());
    await waitFor(() => expect(r.getByText('Connect TikTok')).toBeTruthy());
    expect(complete).not.toHaveBeenCalled();
    expect(r.queryByTestId('tiktok-error')).toBeNull();
    expect(r.queryByTestId('tiktok-cancelled')).toBeNull();
  });

  it('says quietly that nothing was connected when they declined on the platform screen', async () => {
    openAuth.mockResolvedValue({ type: 'success', url: 'mealio://creator/connect?platform=tiktok&outcome=cancelled' });
    const r = await show({ platform: 'tiktok', embedded: true });
    fireEvent.press(r.getByText('Connect TikTok'));
    await waitFor(() => expect(r.getByTestId('tiktok-cancelled')).toBeTruthy());
    expect(r.getByText('You cancelled on TikTok’s screen. Nothing was connected.')).toBeTruthy();
    expect(r.queryByTestId('tiktok-error')).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it('shows the sentence for whatever reason the redirect failed with', async () => {
    // Not only `expired`: TikTok refusing the account is `unavailable`.
    openAuth.mockResolvedValue({
      type: 'success',
      url: 'mealio://creator/connect?platform=tiktok&outcome=failed&reason=unavailable',
    });
    const r = await show({ platform: 'tiktok', embedded: true });
    fireEvent.press(r.getByText('Connect TikTok'));
    await waitFor(() => expect(r.getByTestId('tiktok-error')).toBeTruthy());
    expect(r.getByText(/TikTok would not connect that account/)).toBeTruthy();
    expect(complete).not.toHaveBeenCalled();
  });

  it('falls back to a plain sentence for a reason it has no words for', async () => {
    openAuth.mockResolvedValue({
      type: 'success',
      url: 'mealio://creator/connect?platform=tiktok&outcome=failed&reason=something-new',
    });
    const r = await show({ platform: 'tiktok', embedded: true });
    fireEvent.press(r.getByText('Connect TikTok'));
    await waitFor(() => expect(r.getByText('That connection did not complete.')).toBeTruthy());
  });

  it('shows the server’s message when the exchange is refused', async () => {
    openAuth.mockResolvedValue({ type: 'success', url: 'mealio://creator/connect?platform=instagram&code=c&state=s' });
    // A sentence the app has no copy of, so it can only have come from the server.
    complete.mockResolvedValue({
      ok: false,
      outcome: 'failed',
      reason: 'expired',
      message: 'Instagram took too long to answer us. Start again from this page.',
    });
    const r = await show({ platform: 'instagram', embedded: true });
    fireEvent.press(r.getByText('Connect Instagram'));
    await waitFor(() => expect(r.getByText('Instagram took too long to answer us. Start again from this page.')).toBeTruthy());
  });

  it('shows the message carried by a 403 on a state that does not verify', async () => {
    openAuth.mockResolvedValue({ type: 'success', url: 'mealio://creator/connect?platform=instagram&code=c&state=forged' });
    complete.mockRejectedValue(new ApiError(403, 'HTTP 403', {
      ok: false,
      outcome: 'failed',
      reason: 'unverified',
      message: 'We could not match that connection to you. Start again from this page.',
    }));
    const r = await show({ platform: 'instagram', embedded: true });
    fireEvent.press(r.getByText('Connect Instagram'));
    await waitFor(() => expect(r.getByText('We could not match that connection to you. Start again from this page.')).toBeTruthy());
  });

  it('shows the start route’s refusal without opening a browser', async () => {
    start.mockRejectedValue(new ApiError(500, 'TikTok connection is not configured on this deployment.'));
    const r = await show({ platform: 'tiktok', embedded: true });
    fireEvent.press(r.getByText('Connect TikTok'));
    await waitFor(() => expect(r.getByText('TikTok connection is not configured on this deployment.')).toBeTruthy());
    expect(openAuth).not.toHaveBeenCalled();
  });
});

describe('PlatformConnectCard — what it says before the press', () => {
  it('shows Instagram’s tester note above the button', async () => {
    const note = CREATOR_SOURCE_OPTIONS.find((o) => o.source === 'instagram')!.note;
    const r = await show({ platform: 'instagram', embedded: true, note });
    expect(r.getByTestId('note-instagram')).toBeTruthy();
    expect(r.getByText(/only accounts Mealio has invited as testers can connect/)).toBeTruthy();
  });

  it('says syncing is not switched on instead of offering a button that cannot work', async () => {
    status.mockResolvedValue({ ...NOT_CONNECTED, configured: false });
    const r = await show({ platform: 'tiktok', embedded: true });
    expect(r.getByTestId('unconfigured-tiktok')).toBeTruthy();
    expect(r.queryByText('Connect TikTok')).toBeNull();
  });

  it('asks a broken grant to reconnect and does not report it as connected', async () => {
    const onConnectionChange = jest.fn();
    status.mockResolvedValue({ ...CONNECTED, brokenReason: 'the token was revoked.' });
    const r = await show({ platform: 'instagram', embedded: true, onConnectionChange });
    expect(r.getByText(/Your Instagram connection stopped working/)).toBeTruthy();
    expect(r.getByText('Connect Instagram')).toBeTruthy();
    expect(onConnectionChange).toHaveBeenCalledWith(false);
  });

  it('standalone, disconnects through the server and re-reads', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => {
      buttons.find((b: any) => b.text === 'Disconnect').onPress();
    });
    status.mockResolvedValue(CONNECTED);
    const r = await show({ platform: 'instagram' });
    fireEvent.press(r.getByText('Disconnect Instagram'));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('instagram'));
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
  });
});
