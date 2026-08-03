// The creator's four platform links, editable from the app (MEAL-94).
//
// What these assert is the half that is easy to get wrong: the link that Mealio
// is *currently reading* is not like the other three. Touching it — changing it
// or clearing it, one rule for both — pauses the import, and the creator has to
// be told that before they edit and again after they save. The pause itself is
// the server's decision; this card's job is to send the edit, stop claiming the
// import is running the moment the server says it isn't, and repeat the server's
// own sentence rather than inventing a second one.
//
// The clearing case has its own test because it was the last thing to change on
// the server: it used to be refused outright, and a client that still pre-empts
// it with its own refusal would block an edit the route now accepts.

import { fireEvent, render, waitFor } from '@testing-library/react-native';

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

jest.mock('../../src/lib/api', () => ({
  creators: { updateLinks: jest.fn(async () => ({ ok: true, notices: [], importPaused: false })) },
}));

import PlatformLinksCard from '../../src/components/PlatformLinksCard';
import { creators as creatorsApi } from '../../src/lib/api';

const updateLinks = creatorsApi.updateLinks as unknown as jest.Mock;

/** A creator whose website is the link Mealio is actually reading. */
const POLLED = {
  id: 'c1',
  displayName: 'Sarah',
  websiteUrl: 'https://chefsarah.test/',
  youtubeUrl: null,
  instagramUrl: null,
  tiktokUrl: null,
  primarySource: 'website',
  importOptIn: true,
} as any;

/** The same creator with nothing being polled — the ordinary case. */
const IDLE = { ...POLLED, primarySource: 'none', importOptIn: false };

const PAUSE_NOTICE =
  'Your Website link is saved. Mealio was importing your recipes from it, so we have paused that import until ' +
  'someone here has checked the new link — nothing is read from it in the meantime. Somebody has been told; there ' +
  'is nothing else for you to do.';

const REMOVAL_NOTICE =
  'Your Website link is removed. Mealio was importing your recipes from it, so that import has stopped — there is ' +
  'nothing left for us to read. Somebody has been told; if you want importing to start again, send us the new link.';

beforeEach(() => {
  updateLinks.mockReset();
  updateLinks.mockResolvedValue({ ok: true, notices: [], importPaused: false });
});

/** Renders the card and opens the editor. */
function openEditor(creator: any = IDLE, onSaved: () => void = () => {}) {
  const r = render(<PlatformLinksCard creator={creator} onSaved={onSaved} />);
  fireEvent.press(r.getByText('Manage links'));
  return r;
}

describe('PlatformLinksCard — saying which link is the one being read', () => {
  it('names the polled source before the creator edits it, not after', () => {
    // The whole point of saying it early: "this is where your recipes come from"
    // is why changing or clearing that link pauses the import. A creator who
    // reads it first is never surprised by the pause.
    const r = render(<PlatformLinksCard creator={POLLED} onSaved={() => {}} />);
    expect(r.getAllByText(/importing your recipes from your Website/i).length).toBeGreaterThan(0);
    expect(r.getAllByText(/Change or clear it here and we'll pause the import/i).length).toBeGreaterThan(0);
  });

  it('says nothing of the sort when nothing is being polled', () => {
    // Adding a link tells us a place exists and nothing more. Claiming an import
    // that is switched off would promise a creator something they are not
    // getting, and would warn them off an edit that costs nothing.
    const r = render(<PlatformLinksCard creator={IDLE} onSaved={() => {}} />);
    expect(r.queryByText(/importing your recipes/i)).toBeNull();
  });

  it('does not claim an import for a source that is set but switched off', () => {
    const r = render(
      <PlatformLinksCard creator={{ ...POLLED, importOptIn: false }} onSaved={() => {}} />,
    );
    expect(r.queryByText(/importing your recipes/i)).toBeNull();
  });
});

describe('PlatformLinksCard — saving', () => {
  it('sends all four boxes, so a save cannot clear a link nobody touched', () => {
    // The route reads a missing key as "leave this one alone" and an empty
    // string as "remove this". Sending only the changed box would be safe; not
    // sending the untouched ones as their current value is what would silently
    // drop them if that ever changed. All four, always, as strings.
    const r = openEditor({ ...IDLE, youtubeUrl: 'https://youtube.com/@sarah' });
    fireEvent.changeText(r.getByPlaceholderText('instagram.com/chefsarah'), 'instagram.com/sarah');
    fireEvent.press(r.getByText('Save links'));

    return waitFor(() => {
      expect(updateLinks).toHaveBeenCalledWith({
        website: 'https://chefsarah.test/',
        youtube: 'https://youtube.com/@sarah',
        instagram: 'instagram.com/sarah',
        tiktok: '',
      });
    });
  });

  it('re-reads the row after a save rather than guessing what was stored', async () => {
    // Links are normalised server-side — `chefsarah.com` is stored as
    // `https://chefsarah.com/`. Asking is one request more than predicting and
    // cannot be wrong, and it refreshes the polling columns in the same breath.
    const onSaved = jest.fn();
    const r = openEditor(IDLE, onSaved);
    fireEvent.changeText(r.getByPlaceholderText('chefsarah.com'), 'chefsarah.com');
    fireEvent.press(r.getByText('Save links'));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('catches a typo without spending a round trip', async () => {
    const r = openEditor(IDLE);
    fireEvent.changeText(r.getByPlaceholderText('youtube.com/@chefsarah'), 'https://vimeo.com/sarah');
    fireEvent.press(r.getByText('Save links'));

    await waitFor(() => expect(r.getByText(/YouTube: That link is not on YouTube/i)).toBeTruthy());
    expect(updateLinks).not.toHaveBeenCalled();
  });

  it("shows the route's own sentence when the route is the one refusing", async () => {
    // The server explains why a particular link was refused; re-wording it here
    // would lose the explanation and leave the creator guessing.
    updateLinks.mockRejectedValue(new Error('Only approved creators have links to edit.'));
    const r = openEditor(IDLE);
    fireEvent.changeText(r.getByPlaceholderText('chefsarah.com'), 'chefsarah.com');
    fireEvent.press(r.getByText('Save links'));

    await waitFor(() => expect(r.getByText('Only approved creators have links to edit.')).toBeTruthy());
  });
});

describe('PlatformLinksCard — touching the link that is being polled', () => {
  it('changing it pauses the import, and the card stops claiming otherwise', async () => {
    updateLinks.mockResolvedValue({ ok: true, notices: [PAUSE_NOTICE], importPaused: true });

    const r = openEditor(POLLED);
    fireEvent.changeText(r.getByPlaceholderText('chefsarah.com'), 'https://newsarah.test/');
    fireEvent.press(r.getByText('Save links'));

    // Said in the same breath as the save, in the server's words.
    await waitFor(() => expect(r.getByText(PAUSE_NOTICE)).toBeTruthy());

    // And the sentence above it — "Mealio is importing your recipes from your
    // Website" — is gone. `creator` is the portal's copy of a row the server has
    // just changed; without acting on `importPaused` the card would go on
    // claiming an import directly above a notice saying we had stopped.
    expect(r.queryByText(/importing your recipes from your Website/i)).toBeNull();
  });

  it('clearing it is sent, not refused on the client', async () => {
    // The server used to refuse a cleared polled link and now takes it down the
    // same path as a move: the edit lands, polling stops, an operator is told. A
    // client that kept the old refusal would block an edit the route accepts,
    // and the creator would have no way around it.
    updateLinks.mockResolvedValue({ ok: true, notices: [REMOVAL_NOTICE], importPaused: true });

    const r = openEditor(POLLED);
    fireEvent.changeText(r.getByPlaceholderText('chefsarah.com'), '');
    fireEvent.press(r.getByText('Save links'));

    await waitFor(() => expect(updateLinks).toHaveBeenCalled());
    // An empty string, which is the only value that unambiguously says "remove".
    expect(updateLinks.mock.calls[0][0].website).toBe('');

    await waitFor(() => expect(r.getByText(REMOVAL_NOTICE)).toBeTruthy());
    expect(r.queryByText(/importing your recipes from your Website/i)).toBeNull();
  });

  it('leaves the other three alone — clearing one is not clearing them all', async () => {
    const r = openEditor({ ...POLLED, tiktokUrl: 'https://tiktok.com/@sarah' });
    fireEvent.changeText(r.getByPlaceholderText('chefsarah.com'), '');
    fireEvent.press(r.getByText('Save links'));

    await waitFor(() => expect(updateLinks).toHaveBeenCalled());
    expect(updateLinks.mock.calls[0][0].tiktok).toBe('https://tiktok.com/@sarah');
  });

  it('reports a pause the creator did not aim for, when the row stops adding up', async () => {
    // The server's backstop: an edit can leave a row that cannot be polled
    // coherently even when no link the creator touched was the polled one. Its
    // verdict stops the polling rather than the edit, and the creator is told
    // plainly instead of being hard-blocked from touching any of their links.
    const backstop =
      "We've paused importing your recipes automatically. The import settings on your account no longer add up, " +
      "and we'd rather stop than publish the wrong thing under your name — get in touch and we'll sort it out.";
    updateLinks.mockResolvedValue({ ok: true, notices: [backstop], importPaused: true });

    const r = openEditor(POLLED);
    fireEvent.changeText(r.getByPlaceholderText('instagram.com/chefsarah'), 'instagram.com/sarah');
    fireEvent.press(r.getByText('Save links'));

    await waitFor(() => expect(r.getByText(backstop)).toBeTruthy());
  });

  it('passes on a notice about a grant a cleared link did not disconnect', async () => {
    // Removing an Instagram URL does not revoke the Instagram grant — the grant
    // is a separate record made on a separate screen. Saying nothing would leave
    // a creator believing they had disconnected something they had not.
    const grantNotice =
      'Your connected Instagram account is still connected — removing the link here does not disconnect it, and ' +
      'Mealio can still read what you allowed it to. Disconnect it from the Instagram card if that is what you meant.';
    updateLinks.mockResolvedValue({ ok: true, notices: [grantNotice], importPaused: false });

    const r = openEditor({ ...IDLE, instagramUrl: 'https://instagram.com/sarah' });
    fireEvent.changeText(r.getByPlaceholderText('instagram.com/chefsarah'), '');
    fireEvent.press(r.getByText('Save links'));

    await waitFor(() => expect(r.getByText(grantNotice)).toBeTruthy());
  });
});
