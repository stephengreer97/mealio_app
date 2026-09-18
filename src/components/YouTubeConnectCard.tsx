import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { YouTubeConnection } from '../types';
import { creators as creatorsApi } from '../lib/api';
import { connectPlatform } from '../lib/creatorConnect';
import Card from './ui/Card';
import Button from './ui/Button';
import { Badge, OutlineButton, ui } from './creatorUi';

// ─────────────────────────────────────────────────────────────────────────────
// YouTubeConnectCard: connect a channel, from the creator portal (MEAL-74)
//
// The mobile port of the web portal's card of the same name, and it follows it
// line for line. Three decisions on one card, deliberately not the same one:
//
//   1. Connecting lets Mealio read the channel: titles and descriptions.
//   2. Reading captions, for a video whose description is too short. Its own
//      control, because Google sells it only through `youtube.force-ssl`
//      (MEAL-138), and a creator must not have to agree to description editing
//      to have their subtitles read.
//   3. Editing descriptions: adding the Mealio link once a recipe from a video
//      is live. Off by default and switchable in one tap (MEAL-77).
//
// Connecting happens in the app now: the consent screen runs in the system
// browser (Google refuses it in an embedded WebView) and the server hands the
// result back to `mealio://creator/connect`. See lib/creatorConnect.ts.
//
// **Embedded** is how the Settings tab's sync section shows it: no card chrome,
// no eyebrow, no hiding for a creator without a channel link (they have just
// picked YouTube from "Where you publish", which says the same thing more
// directly), and disconnecting belongs to the section except for a broken
// grant, which the section reads as "not connected" and so offers no button for.
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  embedded?: boolean;
  /** Told whether a usable channel is connected, every time the card learns it. */
  onConnectionChange?: (connected: boolean) => void;
  /** Told when a connect round trip from this card has just succeeded. */
  onConnected?: () => void;
}

export default function YouTubeConnectCard({ embedded = false, onConnectionChange, onConnected }: Props) {
  const [status, setStatus] = useState<YouTubeConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** The quiet "you cancelled on Google's screen" line. Not an error. */
  const [notice, setNotice] = useState('');
  /** The tick on the connect form, before there is a connection to store it on. */
  const [appendConsent, setAppendConsent] = useState(false);
  /** Ticking turned the append on with no trip to Google (MEAL-196): say so. */
  const [justEnabled, setJustEnabled] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const changeRef = useRef(onConnectionChange);
  changeRef.current = onConnectionChange;

  const load = useCallback(async () => {
    try {
      const next = await creatorsApi.youtube.status();
      if (!mounted.current) return;
      setStatus(next);
      // Seeded from the stored flag: the tick is a current permission, and
      // showing a granted one as off would quietly withdraw it on a reconnect.
      setAppendConsent(next.appendOptIn === true);
      // A broken grant is not a connection as far as the section is concerned:
      // nothing can be listed through it.
      changeRef.current?.(next.connected && !next.brokenReason);
    } catch {
      // A card that cannot say what is connected says nothing.
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * Start a consent round trip. `write` is passed by the append tick when it
   * needs the write scope; `captions` asks for captions and carries no answer
   * about editing at all (the field is omitted, never `false` and never the
   * stored value).
   */
  async function connect(options: { write?: boolean; captions?: boolean } = {}) {
    setBusy(true);
    setError('');
    setNotice('');
    const payload: { appendOptIn?: boolean; captions?: true } = {};
    if (options.captions) payload.captions = true;
    if (options.write !== undefined) payload.appendOptIn = options.write;
    else if (!options.captions) payload.appendOptIn = appendConsent;

    const outcome = await connectPlatform('youtube', payload);
    if (!mounted.current) return;
    if (outcome.kind === 'connected') {
      await load();
      if (!mounted.current) return;
      onConnected?.();
    } else if (outcome.kind === 'cancelled') {
      setNotice(outcome.message);
    } else if (outcome.kind === 'failed') {
      setError(outcome.message);
    }
    setBusy(false);
  }

  async function setAppendOptIn(next: boolean) {
    setBusy(true);
    setError('');
    setJustEnabled(false);
    try {
      const result = await creatorsApi.youtube.setAppendOptIn(next);
      if (!mounted.current) return;
      // From the answer, not the request: this is consent to edit somebody
      // else's property.
      const stored = result?.appendOptIn === true;
      setStatus((prev) => (prev ? { ...prev, appendOptIn: stored } : prev));
      setAppendConsent(stored);
      setJustEnabled(stored);
      setBusy(false);
    } catch (err: any) {
      if (!mounted.current) return;
      // The connection has read access only, which is the ordinary case: the
      // write scope is asked for when somebody ticks this box. Ticking it is
      // the request, and Google's consent screen is the rest of it.
      if (err?.body?.needsConsent) {
        setAppendConsent(true);
        await connect({ write: true });
        return;
      }
      setError(err?.message || 'Could not save that.');
      setBusy(false);
    }
  }

  function disconnect() {
    Alert.alert(
      'Disconnect YouTube?',
      'Mealio stops reading your videos and forgets the connection. Recipes you have already published stay exactly where they are.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            setError('');
            try {
              await creatorsApi.youtube.disconnect();
              // Never assumed: re-read rather than guess.
              await load();
            } catch (err: any) {
              if (mounted.current) setError(err?.message || 'Could not disconnect that channel.');
            } finally {
              if (mounted.current) setBusy(false);
            }
          },
        },
      ],
    );
  }

  if (loading || !status) return null;

  // Standalone, nothing at all for a creator with no channel (MEAL-78).
  // Embedded, the creator has just picked YouTube, so the card is the way on.
  if (!status.hasChannel && !embedded) return null;

  const hasConnection = status.connected;
  const needsConnect = !status.connected || Boolean(status.brokenReason);
  const consent = hasConnection ? status.appendOptIn === true : appendConsent;
  const canReadCaptions = status.canReadCaptions ?? status.canWriteDescriptions;

  const body = (
    <>
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          {!embedded && <Text style={ui.eyebrow}>YOUTUBE</Text>}
          <Text style={ui.title}>
            {status.connected ? status.channel?.title || 'Connected channel' : 'Connect your channel'}
          </Text>
        </View>
        {status.connected && !status.brokenReason && <Badge label="Connected" tone="green" testID="youtube-connected" />}
      </View>

      {!!notice && <Text style={[ui.hint, styles.gap]} testID="youtube-cancelled">{notice}</Text>}

      {/* A grant that has stopped working looks exactly like a channel that
          published nothing, so it is stated to the one person who can fix it. */}
      {!!status.brokenReason && (
        <Text style={[ui.error, styles.gap]}>
          Your YouTube connection stopped working: {status.brokenReason} Reconnect to carry on importing.
        </Text>
      )}

      <Text style={[ui.body, styles.gapLg]}>
        {needsConnect
          ? 'Connecting lets Mealio read your videos’ titles and descriptions, so a recipe can be imported from a video instead of typed out again.'
          : 'Mealio can read this channel’s videos to import recipes from them.'}
      </Text>

      {hasConnection && !canReadCaptions && (
        <View style={styles.captions} testID="youtube-captions">
          <Text style={styles.captionsText}>
            <Text style={styles.captionsLead}>Mealio cannot read this channel’s captions.</Text> Any video where the
            recipe is spoken rather than written out in the description gets skipped. There is nothing for us to
            read. YouTube shares captions only with the channel owner, and only through a permission this connection
            was not given.
          </Text>
          <Button
            label={busy ? 'Opening Google…' : 'Let Mealio read my captions'}
            onPress={() => { void connect({ captions: true }); }}
            disabled={busy}
            size="sm"
            style={styles.captionsButton}
          />
          <Text style={styles.captionsSmall}>
            Google has no permission for captions alone, so its screen will mention editing your videos. Mealio still
            edits nothing unless you tick the box below. That is a separate setting, off unless you turn it on, and
            this does not turn it on.
          </Text>
        </View>
      )}
      {hasConnection && canReadCaptions && (
        <Text style={[ui.body, styles.gapLg]}>
          Mealio can also read this channel’s captions, so a video whose description is too short still gets its
          recipe read from what you say in it.
        </Text>
      )}

      {/* One control whichever state the card is in: on a connection it writes
          through at once (so consent can be withdrawn from a broken grant too);
          with nothing connected it is a local tick that travels with the
          connect request. Never locked for want of the write scope: the PATCH
          answers `needsConsent` and the tick becomes a consent trip. */}
      <TouchableOpacity
        style={styles.consentRow}
        onPress={() => (hasConnection ? setAppendOptIn(!consent) : setAppendConsent(!consent))}
        disabled={busy}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: consent, disabled: busy }}
        accessibilityLabel="Let Mealio add the Mealio link to a video’s description"
        testID="youtube-append"
        activeOpacity={0.8}
      >
        <View style={[ui.checkbox, consent && ui.checkboxOn]}>
          {consent && <Feather name="check" size={14} color="#fff" />}
        </View>
        <Text style={[ui.body, styles.flex]}>
          <Text style={ui.strong}>
            {needsConnect ? 'Also let' : 'Let'} Mealio add the Mealio link to a video’s description
          </Text>{' '}
          once a recipe from that video is live. Only for videos a Mealio recipe came from, and always shown to you
          first.{' '}
          {needsConnect
            ? 'You can switch this off at any time, and left unticked nothing on your channel is ever edited.'
            : 'Switching this off stops any future edits; links already added stay where they are. It does not remove the permission from your Google Account, which you can do at any time in your Google Account permissions.'}
        </Text>
      </TouchableOpacity>

      {justEnabled && (
        <Text style={[ui.body, styles.gap]} testID="append-just-enabled">
          Mealio can now add the Mealio link to descriptions on this channel. Untick the box above to stop it.
        </Text>
      )}

      {needsConnect && (
        <View>
          <Button
            label={busy ? 'Opening Google…' : consent ? 'Connect YouTube and edit descriptions' : 'Connect YouTube'}
            onPress={() => { void connect(); }}
            disabled={busy}
            testID="youtube-connect"
          />
          <Text style={[ui.hint, styles.small]}>
            {consent
              ? 'Google will ask for permission to see, edit and delete your YouTube videos. That one permission is the only way it lets us add a link to a description. We use it to read your videos and to add that link, nothing else.'
              : 'Google will ask for permission to view your YouTube account. We use it to read your videos’ titles and descriptions.'}
          </Text>
        </View>
      )}

      {/* Offered whenever a grant exists, broken included: a creator who cannot
          reconnect must still be able to take the stored token away. Embedded,
          the sync section owns it, except for the broken grant it cannot see. */}
      {hasConnection && (!embedded || Boolean(status.brokenReason)) && (
        <OutlineButton
          label="Disconnect YouTube"
          onPress={disconnect}
          disabled={busy}
          testID="youtube-disconnect"
          style={styles.disconnect}
        />
      )}

      {!!error && <Text style={[ui.error, styles.errorGap]} testID="youtube-error">{error}</Text>}
    </>
  );

  if (embedded) return <View testID="youtube-connect-card">{body}</View>;
  return <Card style={styles.card}><View testID="youtube-connect-card">{body}</View></Card>;
}

const styles = StyleSheet.create({
  card: { marginBottom: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8, gap: 8 },
  headerText: { flex: 1, minWidth: 0 },
  gap: { marginBottom: 10 },
  gapLg: { marginBottom: 12 },
  flex: { flex: 1 },
  small: { marginTop: 8 },
  captions: {
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FDE68A',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  captionsText: { fontSize: 13, fontFamily: 'Inter_400Regular', color: '#78350F', lineHeight: 19 },
  captionsLead: { fontFamily: 'Inter_600SemiBold' },
  captionsButton: { marginTop: 10, alignSelf: 'flex-start', paddingHorizontal: 14, backgroundColor: '#D97706' },
  captionsSmall: { fontSize: 11, fontFamily: 'Inter_400Regular', color: '#92400E', lineHeight: 16, marginTop: 8 },
  consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 12 },
  disconnect: { marginTop: 12 },
  errorGap: { marginTop: 10 },
});

