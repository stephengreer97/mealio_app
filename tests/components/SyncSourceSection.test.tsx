// "Sync your content with Mealio" on the phone: the port of the web portal's
// SyncSourceSection, held to the web's rules.
//
//   • The picker offers all four sources, Instagram with its tester note.
//   • Nothing is written by opening the screen; a choice is written once the
//     source is ready. Switching away from a live source says what stops.
//   • Website Save goes through the server's check and shows its sentence.
//   • Disconnect revokes first, then clears the source.
//   • The back catalogue: the cap holds at the tick, Import sends exactly the
//     ticked posts with `reselect` on the refused ones, a run already under way
//     comes back with Carry on, and the daily cap says the server's sentence.

import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { Alert } from 'react-native';

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  const icon = (props: any) => RealReact.createElement(RealText, null, props.name);
  return { Ionicons: icon, Feather: icon, MaterialIcons: icon };
});

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn(async () => ({ type: 'dismiss' })) }));

const mockRefreshDrafts = jest.fn(async () => {});
jest.mock('../../src/context/CreatorDraftsContext', () => ({
  useCreatorDrafts: () => ({ waiting: 0, refresh: mockRefreshDrafts, setWaiting: jest.fn() }),
}));

jest.mock('../../src/lib/api', () => ({
  creators: {
    setPrimarySource: jest.fn(),
    checkWebsite: jest.fn(),
    youtube: { status: jest.fn(), setAppendOptIn: jest.fn(), disconnect: jest.fn() },
    connections: { status: jest.fn(), disconnect: jest.fn(), start: jest.fn(), complete: jest.fn() },
    sync: { catalog: jest.fn(), start: jest.fn(), read: jest.fn(), advance: jest.fn() },
  },
}));

import { ApiError } from '../../src/lib/authErrors';
import SyncSourceSection from '../../src/components/SyncSourceSection';
import { creators as creatorsApi } from '../../src/lib/api';
import { CREATOR_SELECTION_MAX } from '../../src/constants/creatorSources';

const api = creatorsApi as any;

const WEBSITE_LIVE = {
  id: 'c1',
  displayName: 'Sarah',
  websiteUrl: 'https://chefsarah.test/',
  feedUrl: 'https://chefsarah.test/feed/',
  youtubeUrl: null,
  instagramUrl: null,
  tiktokUrl: null,
  primarySource: 'website',
  importOptIn: true,
};

const FRESH = {
  id: 'c1',
  displayName: 'Sarah',
  websiteUrl: null,
  feedUrl: null,
  youtubeUrl: null,
  instagramUrl: null,
  tiktokUrl: null,
  primarySource: null,
  importOptIn: false,
};

const YT_CONNECTED = {
  hasChannel: true, connected: true, channel: { id: 'UC1', title: "Sarah's Kitchen" },
  brokenReason: null, canWriteDescriptions: true, canReadCaptions: true, appendOptIn: false,
};

function entry(itemId: string, status: string | null = null, extra: any = {}) {
  return {
    itemId,
    url: `https://chefsarah.test/${itemId}`,
    title: `Post ${itemId}`,
    publishedAt: '2026-08-01T00:00:00Z',
    record: status ? { status, detail: null, at: null, firstSeenAt: null, draftId: null, inFlight: false, ...extra } : null,
  };
}

function catalog(entries: any[], nextPageToken: string | null = null) {
  return { ok: true, source: 'website', entries, truncated: false, nextPageToken };
}

const DONE_RUN = (items: any[]) => ({
  id: 'run1',
  source: 'website',
  status: 'done',
  items: items.map((e) => ({ ...e, status: 'drafted', detail: null, draftId: 'd', mealName: e.title, needALook: 0 })),
});

beforeEach(() => {
  jest.clearAllMocks();
  api.setPrimarySource.mockResolvedValue({ ok: true });
  api.youtube.status.mockResolvedValue({ ...YT_CONNECTED, connected: false, channel: null });
  api.connections.status.mockResolvedValue({ connected: false, account: null, brokenReason: null, expiresAt: null, configured: true });
  api.connections.disconnect.mockResolvedValue({ ok: true });
  api.sync.catalog.mockResolvedValue(catalog([entry('a'), entry('b')]));
  api.sync.read.mockResolvedValue({ run: null });
});

afterEach(() => jest.restoreAllMocks());

function confirmAlerts() {
  jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => {
    buttons.find((b: any) => b.style === 'destructive').onPress();
  });
}

describe('the picker', () => {
  it('offers all four sources, in the web’s order, and opens a fresh creator on Website', async () => {
    const r = render(<SyncSourceSection creator={FRESH as any} />);
    const labels = ['website', 'youtube', 'instagram', 'tiktok'].map(
      (s) => within(r.getByTestId(`source-option-${s}`)).getByText(/./).props.children,
    );
    expect(labels).toEqual(['Website or blog', 'YouTube', 'Instagram', 'TikTok']);
    expect(r.getByTestId('source-option-website').props.accessibilityState.selected).toBe(true);
    expect(r.getByTestId('website-panel')).toBeTruthy();
    // Opening claims nothing.
    expect(api.setPrimarySource).not.toHaveBeenCalled();
  });

  it('shows Instagram’s tester note once Instagram is picked', async () => {
    const r = render(<SyncSourceSection creator={FRESH as any} />);
    fireEvent.press(r.getByTestId('source-option-instagram'));
    expect(await r.findByTestId('note-instagram')).toBeTruthy();
    expect(r.getByText(/Instagram is still reviewing Mealio/)).toBeTruthy();
    expect(r.getByText('Connect Instagram')).toBeTruthy();
  });

  it('warns what stops when switching away from a source being synced', async () => {
    api.youtube.status.mockResolvedValue(YT_CONNECTED);
    const onSaved = jest.fn();
    const r = render(<SyncSourceSection creator={WEBSITE_LIVE as any} onSaved={onSaved} />);
    await r.findByTestId('catalogue');

    fireEvent.press(r.getByTestId('source-option-youtube'));

    const warning = await r.findByTestId('switch-warning');
    expect(within(warning).getByText(/Mealio now syncs from YouTube only/)).toBeTruthy();
    expect(within(warning).getByText(/Anything new you post to Website will not be imported/)).toBeTruthy();
    // YouTube is connected, so the choice takes effect.
    await waitFor(() => expect(api.setPrimarySource).toHaveBeenCalledWith('youtube'));
    expect(onSaved).toHaveBeenCalledWith({ primarySource: 'youtube', importOptIn: true });
  });

  it('does not warn when nothing was being synced', async () => {
    const r = render(<SyncSourceSection creator={FRESH as any} />);
    fireEvent.press(r.getByTestId('source-option-tiktok'));
    await r.findByText('Connect TikTok');
    expect(r.queryByTestId('switch-warning')).toBeNull();
    // TikTok is not connected, so nothing is written yet.
    expect(api.setPrimarySource).not.toHaveBeenCalled();
  });
});

describe('connecting is the answer to the picker', () => {
  it('writes the source once a connect from the section succeeds, with no second press', async () => {
    // Opened on TikTok (stored, not being synced), nothing touched: connecting
    // is itself the choice.
    const WebBrowser = require('expo-web-browser');
    WebBrowser.openAuthSessionAsync.mockResolvedValue({
      type: 'success',
      url: 'mealio://creator/connect?platform=tiktok&code=c&state=s',
    });
    api.connections.start.mockResolvedValue({ url: 'https://tiktok.test/auth' });
    api.connections.complete.mockResolvedValue({ ok: true, outcome: 'connected' });
    const r = render(<SyncSourceSection creator={{ ...FRESH, primarySource: 'tiktok' } as any} />);
    fireEvent.press(await r.findByText('Connect TikTok'));
    api.connections.status.mockResolvedValue({
      connected: true, account: { id: '1', name: 'sarah' }, brokenReason: null, expiresAt: null, configured: true,
    });

    await waitFor(() => expect(api.connections.complete).toHaveBeenCalledWith('tiktok', 'c', 's'));
    await waitFor(() => expect(api.setPrimarySource).toHaveBeenCalledWith('tiktok'));
    expect(await r.findByTestId('sync-status')).toBeTruthy();
  });

  it('does not write anything just because a connected source was opened', async () => {
    api.connections.status.mockResolvedValue({
      connected: true, account: { id: '1', name: 'sarah' }, brokenReason: null, expiresAt: null, configured: true,
    });
    const r = render(<SyncSourceSection creator={{ ...FRESH, primarySource: 'tiktok' } as any} />);
    await r.findByTestId('tiktok-connected');
    expect(api.setPrimarySource).not.toHaveBeenCalled();
  });
});

describe('the website', () => {
  it('sends the address to the server check and shows the sentence it refuses with', async () => {
    api.checkWebsite.mockResolvedValue({
      ok: false,
      error: 'We could not find a feed on https://chefsarah.test/. Mealio follows your posts through an RSS or Atom feed.',
    });
    const r = render(<SyncSourceSection creator={FRESH as any} />);
    fireEvent.changeText(r.getByTestId('website-input'), 'chefsarah.test');
    fireEvent.press(r.getByTestId('website-save'));

    await waitFor(() => expect(api.checkWebsite).toHaveBeenCalledWith('chefsarah.test'));
    expect(await r.findByTestId('website-error')).toBeTruthy();
    expect(r.getByText(/We could not find a feed on https:\/\/chefsarah.test\//)).toBeTruthy();
    expect(api.setPrimarySource).not.toHaveBeenCalled();
  });

  it('shows the route’s own error on a thrown refusal', async () => {
    api.checkWebsite.mockRejectedValue(new ApiError(400, 'x', { error: 'That link is not on Website. Example: yourblog.com' }));
    const r = render(<SyncSourceSection creator={FRESH as any} />);
    fireEvent.changeText(r.getByTestId('website-input'), 'chefsarah.test');
    fireEvent.press(r.getByTestId('website-save'));
    expect(await r.findByText('That link is not on Website. Example: yourblog.com')).toBeTruthy();
  });

  it('catches a typo before the round trip', async () => {
    const r = render(<SyncSourceSection creator={FRESH as any} />);
    fireEvent.changeText(r.getByTestId('website-input'), 'instagram.com/sarah');
    fireEvent.press(r.getByTestId('website-save'));
    expect(await r.findByTestId('website-error')).toBeTruthy();
    expect(api.checkWebsite).not.toHaveBeenCalled();
  });

  it('on success says what it found, records the source and draws the catalogue', async () => {
    api.checkWebsite.mockResolvedValue({
      ok: true,
      websiteUrl: 'https://chefsarah.test/',
      feedUrl: 'https://chefsarah.test/feed/',
      detail: '3 of the 3 recent posts we read are recipes Mealio can import.',
    });
    const onSaved = jest.fn();
    const r = render(<SyncSourceSection creator={FRESH as any} onSaved={onSaved} />);
    fireEvent.changeText(r.getByTestId('website-input'), 'chefsarah.test');
    fireEvent.press(r.getByTestId('website-save'));

    expect(await r.findByTestId('website-detail')).toBeTruthy();
    expect(onSaved).toHaveBeenCalledWith({
      websiteUrl: 'https://chefsarah.test/',
      feedUrl: 'https://chefsarah.test/feed/',
      primarySource: 'website',
      importOptIn: true,
    });
    expect(await r.findByTestId('catalogue')).toBeTruthy();
    expect(api.sync.catalog).toHaveBeenCalledWith('website', null);
  });
});

describe('disconnecting', () => {
  it('a website: clears the link with the source, and says Mealio reads nothing', async () => {
    confirmAlerts();
    const onSaved = jest.fn();
    const r = render(<SyncSourceSection creator={WEBSITE_LIVE as any} onSaved={onSaved} />);
    fireEvent.press(await r.findByTestId('sync-disconnect'));

    await waitFor(() => expect(api.setPrimarySource).toHaveBeenCalledWith('none', { clearWebsite: true }));
    expect(api.connections.disconnect).not.toHaveBeenCalled();
    expect(await r.findByTestId('sync-off')).toBeTruthy();
    expect(onSaved).toHaveBeenCalledWith({ primarySource: 'none', importOptIn: false, websiteUrl: null, feedUrl: null });
  });

  it('a platform: revokes the grant first, then stops syncing', async () => {
    confirmAlerts();
    api.youtube.status.mockResolvedValue(YT_CONNECTED);
    const r = render(<SyncSourceSection creator={{ ...WEBSITE_LIVE, primarySource: 'youtube' } as any} />);
    fireEvent.press(await r.findByTestId('sync-disconnect'));

    await waitFor(() => expect(api.setPrimarySource).toHaveBeenCalledWith('none', { clearWebsite: false }));
    expect(api.connections.disconnect).toHaveBeenCalledWith('youtube');
    expect(api.connections.disconnect.mock.invocationCallOrder[0])
      .toBeLessThan(api.setPrimarySource.mock.invocationCallOrder[0]);
    expect(await r.findByTestId('sync-off')).toBeTruthy();
  });

  it('stops at a refused revocation and says it is still connected', async () => {
    confirmAlerts();
    api.youtube.status.mockResolvedValue(YT_CONNECTED);
    api.connections.disconnect.mockRejectedValue(new ApiError(500, 'HTTP 500'));
    const r = render(<SyncSourceSection creator={{ ...WEBSITE_LIVE, primarySource: 'youtube' } as any} />);
    fireEvent.press(await r.findByTestId('sync-disconnect'));

    expect(await r.findByText('We could not disconnect your YouTube. It is still connected. Please try again.')).toBeTruthy();
    expect(api.setPrimarySource).not.toHaveBeenCalled();
  });
});

describe('the back catalogue', () => {
  it('holds the cap at the tick', async () => {
    const many = Array.from({ length: CREATOR_SELECTION_MAX + 5 }, (_, i) => entry(`p${i}`));
    api.sync.catalog.mockResolvedValue(catalog(many));
    const r = render(<SyncSourceSection creator={WEBSITE_LIVE as any} />);
    await r.findByTestId('catalogue');

    fireEvent.press(r.getByText(`Tick the ${CREATOR_SELECTION_MAX} newest`));
    expect(r.getByTestId('selection-count').props.children.join('')).toBe(`${CREATOR_SELECTION_MAX} of ${CREATOR_SELECTION_MAX} chosen`);
    expect(r.getByTestId('cap-reached')).toBeTruthy();

    // One past the cap cannot be ticked...
    const extra = r.getByTestId(`catalogue-row-p${CREATOR_SELECTION_MAX + 2}`);
    expect(extra.props.accessibilityState).toEqual({ checked: false, disabled: true });
    fireEvent.press(extra);
    expect(r.getByTestId('selection-count').props.children.join('')).toBe(`${CREATOR_SELECTION_MAX} of ${CREATOR_SELECTION_MAX} chosen`);

    // ...until one is unticked.
    fireEvent.press(r.getByTestId('catalogue-row-p0'));
    fireEvent.press(r.getByTestId(`catalogue-row-p${CREATOR_SELECTION_MAX + 2}`));
    expect(r.getByTestId(`catalogue-row-p${CREATOR_SELECTION_MAX + 2}`).props.accessibilityState.checked).toBe(true);
    expect(r.getByText(`Import ${CREATOR_SELECTION_MAX} posts`)).toBeTruthy();
  });

  it('leaves imported and refused posts out of the bulk tick, and cannot tick an imported one', async () => {
    api.sync.catalog.mockResolvedValue(catalog([entry('a'), entry('b', 'rejected'), entry('c', 'imported'), entry('d', 'withdrawn')]));
    const r = render(<SyncSourceSection creator={WEBSITE_LIVE as any} />);
    await r.findByTestId('catalogue');

    fireEvent.press(r.getByText('Tick the 2 newest'));
    expect(r.getByTestId('catalogue-row-a').props.accessibilityState.checked).toBe(true);
    expect(r.getByTestId('catalogue-row-d').props.accessibilityState.checked).toBe(true);
    expect(r.getByTestId('catalogue-row-b').props.accessibilityState.checked).toBe(false);
    expect(r.getByTestId('catalogue-row-c').props.accessibilityState.disabled).toBe(true);
    expect(r.getByTestId('not-a-recipe')).toBeTruthy();
    expect(r.getByTestId('withdrawn')).toBeTruthy();
  });

  it('imports exactly the ticked posts, with reselect on a refused one, and drives the run to done', async () => {
    const items = [entry('a'), entry('b', 'rejected'), entry('c', 'declined'), entry('d')];
    api.sync.catalog.mockResolvedValue(catalog(items));
    api.sync.start.mockResolvedValue({ run: { id: 'run1', source: 'website', status: 'queued', items: [] } });
    api.sync.advance.mockResolvedValue({
      run: DONE_RUN([items[0], items[1]]),
      totals: { selected: 2, pending: 0, drafted: 2, rejected: 0, failed: 0, skipped: 0 },
    });
    const r = render(<SyncSourceSection creator={WEBSITE_LIVE as any} />);
    await r.findByTestId('catalogue');

    fireEvent.press(r.getByTestId('catalogue-row-a'));
    fireEvent.press(r.getByTestId('catalogue-row-b'));
    fireEvent.press(r.getByText('Import 2 posts'));

    await waitFor(() => expect(api.sync.start).toHaveBeenCalled());
    expect(api.sync.start).toHaveBeenCalledWith('website', [
      { itemId: 'a', url: 'https://chefsarah.test/a', title: 'Post a', publishedAt: '2026-08-01T00:00:00Z' },
      { itemId: 'b', url: 'https://chefsarah.test/b', title: 'Post b', publishedAt: '2026-08-01T00:00:00Z', reselect: true },
    ]);
    await waitFor(() => expect(api.sync.advance).toHaveBeenCalledWith('run1'));
    expect(await r.findByText('Import finished')).toBeTruthy();
    expect(r.getAllByTestId('run-item-drafted')).toHaveLength(2);
    // The badge and the checklist were read before any of this.
    await waitFor(() => expect(mockRefreshDrafts).toHaveBeenCalled());
    await waitFor(() => expect(api.sync.catalog).toHaveBeenCalledTimes(2));
  });

  it('brings back a run already under way, with Carry on', async () => {
    const underWay = {
      id: 'run0',
      source: 'website',
      status: 'queued',
      items: [{ ...entry('x'), status: 'pending', detail: null, draftId: null, mealName: null, needALook: null }],
    };
    api.sync.start.mockRejectedValue(new ApiError(409, 'An import is already under way.', {
      error: 'An import is already under way. Carry it on, or wait for it to finish, before starting another.',
      run: underWay,
      totals: { selected: 1, pending: 1, drafted: 0, rejected: 0, failed: 0, skipped: 0 },
    }));
    api.sync.advance.mockResolvedValue({
      run: { ...underWay, status: 'done', items: [{ ...underWay.items[0], status: 'drafted' }] },
      totals: { selected: 1, pending: 0, drafted: 1, rejected: 0, failed: 0, skipped: 0 },
    });
    const r = render(<SyncSourceSection creator={WEBSITE_LIVE as any} />);
    await r.findByTestId('catalogue');
    fireEvent.press(r.getByTestId('catalogue-row-a'));
    fireEvent.press(r.getByText('Import 1 post'));

    expect(await r.findByText(/An import is already under way. Carry it on/)).toBeTruthy();
    expect(r.getByTestId('run-summary')).toBeTruthy();
    fireEvent.press(r.getByTestId('carry-on'));
    await waitFor(() => expect(api.sync.advance).toHaveBeenCalledWith('run0'));
    expect(await r.findByText('Import finished')).toBeTruthy();
  });

  it('says the daily cap in the server’s words', async () => {
    const message = 'You have imported 300 posts today, which is the most Mealio reads for one creator in a day. Try again tomorrow.';
    api.sync.start.mockRejectedValue(new ApiError(429, message, { error: message }));
    const r = render(<SyncSourceSection creator={WEBSITE_LIVE as any} />);
    await r.findByTestId('catalogue');
    fireEvent.press(r.getByTestId('catalogue-row-a'));
    fireEvent.press(r.getByText('Import 1 post'));

    expect(await r.findByText(message)).toBeTruthy();
    expect(r.queryByTestId('run-summary')).toBeNull();
    expect(api.sync.advance).not.toHaveBeenCalled();
  });

  it('asks for the next window with a button, and appends it', async () => {
    api.sync.catalog
      .mockResolvedValueOnce(catalog([entry('a'), entry('b')], '2'))
      .mockResolvedValueOnce(catalog([entry('b'), entry('c')], null));
    const r = render(<SyncSourceSection creator={WEBSITE_LIVE as any} />);
    await r.findByTestId('catalogue');
    fireEvent.press(r.getByTestId('load-more'));
    expect(await r.findByTestId('catalogue-row-c')).toBeTruthy();
    expect(api.sync.catalog).toHaveBeenLastCalledWith('website', '2');
    expect(r.queryByTestId('load-more')).toBeNull();
  });

  it('filters by state and never hides everything', async () => {
    api.sync.catalog.mockResolvedValue(catalog([entry('a'), entry('c', 'imported')]));
    const r = render(<SyncSourceSection creator={WEBSITE_LIVE as any} />);
    await r.findByTestId('catalogue');
    fireEvent.press(r.getByTestId('filter-toggle'));
    fireEvent.press(r.getByTestId('filter-imported'));
    expect(r.queryByTestId('catalogue-row-c')).toBeNull();
    expect(r.getByText('Filter · 1 hidden')).toBeTruthy();
  });
});
