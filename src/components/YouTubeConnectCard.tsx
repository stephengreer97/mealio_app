import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { Colors, Radius } from '../constants/colors';
import { YouTubeConnection } from '../types';
import { creators as creatorsApi } from '../lib/api';
import Card from './ui/Card';
import Button from './ui/Button';

// ─────────────────────────────────────────────────────────────────────────────
// YouTubeConnectCard — the description-append setting (MEAL-74 / MEAL-78)
//
// Two things live on this card and they are deliberately not the same thing. A
// connection lets Mealio **read** a channel — titles, descriptions and, for a
// video whose description is thin, captions. The switch beside it is consent to
// **write**: to add the Mealio link to a video's description once a recipe from
// that video is live. MEAL-77 forbids conflating those, so the switch is
// separate, off unless turned on, and revocable in one tap.
//
// Nothing at all is rendered for a creator with no YouTube channel. Hidden, not
// disabled: the switch is a permission over property that is not ours, and a
// permission prompt about a channel that does not exist is one a creator learns
// to tap past — which is exactly what makes the next one worthless. A creator
// who starts a channel later adds the link in the links card above (MEAL-94) and
// this appears.
//
// ── Why connecting leaves the app and disconnecting does not ─────────────────
//
// Connecting is a Google OAuth round trip. Google refuses the consent screen in
// an embedded WebView (its "disallowed_useragent" policy), so it has to run in a
// real browser either way; and `/api/creator/youtube/callback` redirects to
// `mealio.co/creator` with the outcome in the query string, with no deep link
// back into the app. Rebuilding it in-app would mean changing that callback —
// server work this client is not allowed to do — and until then an in-app
// attempt would strand the creator on a web page half way through. So connecting
// opens the web portal, which is where the flow already ends.
//
// Disconnecting is the opposite case and stays here. It is one authenticated
// DELETE with no redirect, and it is revocation: a creator who cannot reconnect
// — the broken-grant case, where reconnecting is exactly what is failing — must
// still be able to take the stored token away from wherever they are. Sending
// them to a browser to withdraw a permission is the one place a detour is not
// acceptable.
// ─────────────────────────────────────────────────────────────────────────────

/** Where the OAuth round trip both starts and ends. */
const PORTAL_URL = 'https://mealio.co/creator';

interface Props {
  /** Lets a test drive the card without a browser; production uses the default. */
  openWeb?: (url: string) => Promise<unknown>;
}

export default function YouTubeConnectCard({ openWeb }: Props) {
  const [status, setStatus] = useState<YouTubeConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setStatus(await creatorsApi.youtube.status());
    } catch {
      // A card that cannot say what is connected says nothing. Guessing here
      // means either inventing a connection or denying a real one, and both are
      // worse than the card not being there this once.
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function connect() {
    setBusy(true);
    setError('');
    try {
      const open = openWeb ?? ((url: string) => WebBrowser.openBrowserAsync(url));
      await open(PORTAL_URL);
      // Whatever happened in the browser, the server knows and we do not.
      await load();
    } catch {
      setError('Could not open the Mealio portal. Try again, or visit mealio.co/creator in your browser.');
    } finally {
      setBusy(false);
    }
  }

  async function setAppendOptIn(next: boolean) {
    setBusy(true);
    setError('');
    try {
      const result = await creatorsApi.youtube.setAppendOptIn(next);
      // From the answer, not from the request. This is consent to edit somebody
      // else's property; showing it as granted before the server has stored it
      // is the one direction of optimism this switch cannot afford.
      setStatus((prev) => (prev ? { ...prev, appendOptIn: result?.appendOptIn === true } : prev));
    } catch (err: any) {
      // The route's own sentence — it is the one that says whether the problem
      // is a missing connection or a missing scope.
      setError(err?.message || 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  function disconnect() {
    Alert.alert(
      'Disconnect YouTube?',
      'Mealio will stop reading your videos, and will not add links to any description. Links already added stay where they are.',
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
              // Never assumed. "Your channel is disconnected" is the last thing
              // a creator will check up on, so it is said only once the server
              // has said so — `load()` re-reads rather than guessing.
              await load();
            } catch (err: any) {
              setError(err?.message || 'Could not disconnect that channel.');
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  if (loading || !status) return null;

  // Nothing at all for a creator with no channel: no grant, and no YouTube link
  // on their row saying one exists.
  if (!status.hasChannel) return null;

  /**
   * A grant exists — healthy or broken. Broken still needs reconnecting, but it
   * is a connection: the consent attached to it is real, revocable, and the
   * channel can still be disconnected. Rendering a broken connection as if
   * nothing were connected would show a granted permission as off and offer no
   * way to withdraw it, which is the opposite of what a broken grant needs.
   */
  const hasConnection = status.connected;
  const needsConnect = !status.connected || Boolean(status.brokenReason);
  const consent = status.appendOptIn === true;
  /**
   * Turning it on needs a live grant carrying the write scope; turning it off
   * must work from every state there is, or it is not revocation. So the lock
   * only ever applies while the switch is already off — the route refuses the
   * "on" either way, and this says why before the tap rather than after it.
   */
  const consentLocked = !consent && (!hasConnection || !status.canWriteDescriptions);
  const lockReason = !hasConnection
    ? 'Connect your channel before turning this on — there is nothing to write to yet.'
    : 'This connection was made without permission to edit descriptions. Reconnect YouTube if you want to allow it.';

  return (
    <Card style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <Text style={styles.eyebrow}>YOUTUBE</Text>
          <Text style={styles.title}>
            {status.connected ? status.channel?.title || 'Connected channel' : 'Connect your channel'}
          </Text>
        </View>
        {status.connected && !status.brokenReason && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Connected</Text>
          </View>
        )}
      </View>

      {/*
        A grant that has stopped working is the failure this whole feature is
        written around: it looks exactly like a channel that published nothing.
        So it is stated here, to the one person who can fix it.
      */}
      {!!status.brokenReason && (
        <Text style={styles.broken}>
          Your YouTube connection stopped working: {status.brokenReason} Reconnect to carry on importing.
        </Text>
      )}

      <Text style={styles.blurb}>
        {needsConnect
          ? 'Connecting lets Mealio read your videos’ titles and descriptions — and their captions, which YouTube only shares with the channel owner — so a recipe can be imported from a video instead of typed out again.'
          : 'Mealio can read this channel’s videos to import recipes from them.'}
      </Text>

      <TouchableOpacity
        style={[styles.consentRow, consentLocked && styles.consentRowLocked]}
        onPress={() => setAppendOptIn(!consent)}
        disabled={busy || consentLocked}
        accessibilityRole="switch"
        accessibilityState={{ checked: consent, disabled: busy || consentLocked }}
        accessibilityLabel="Let Mealio add the Mealio link to a video’s description"
        activeOpacity={0.8}
      >
        <View style={[styles.box, consent && styles.boxOn]}>
          {consent && <Feather name="check" size={14} color="#fff" />}
        </View>
        <Text style={styles.consentText}>
          <Text style={styles.consentLead}>Let Mealio add the Mealio link to a video’s description</Text> once a
          recipe from that video is live. Only for videos a Mealio recipe came from, and always shown to you first.{' '}
          {consent
            ? 'Switching this off stops any future edits; links already added stay where they are.'
            : 'Left off, nothing on your channel is ever edited.'}
        </Text>
      </TouchableOpacity>

      {consentLocked && <Text style={styles.hint}>{lockReason}</Text>}

      {needsConnect && (
        <View style={styles.connectBlock}>
          <Button
            label={busy ? 'Opening…' : 'Connect YouTube on the web'}
            onPress={connect}
            disabled={busy}
            size="sm"
          />
          <Text style={styles.hint}>
            Google will not show its permission screen inside an app, so connecting opens mealio.co/creator in your
            browser and finishes there. Google asks to manage your YouTube account; Mealio uses it to read your
            videos, and — only if the setting above is on — to add a link to a description.
          </Text>
        </View>
      )}

      {/*
        Offered whenever a grant exists, broken included. A creator who cannot
        reconnect must still be able to take the stored token away.
      */}
      {hasConnection && (
        <TouchableOpacity
          onPress={disconnect}
          disabled={busy}
          style={styles.disconnectBtn}
          accessibilityRole="button"
        >
          <Text style={styles.disconnectText}>Disconnect YouTube</Text>
        </TouchableOpacity>
      )}

      {!!error && <Text style={styles.error}>{error}</Text>}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 },
  headerText: { flex: 1, minWidth: 0 },
  eyebrow: { fontSize: 11, fontFamily: 'Inter_600SemiBold', color: Colors.text3, letterSpacing: 1, marginBottom: 2 },
  title: { fontSize: 16, fontFamily: 'Inter_700Bold', color: Colors.text1 },
  badge: {
    borderRadius: 6,
    backgroundColor: '#ECFDF5',
    borderWidth: 1,
    borderColor: '#D1FAE5',
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: { fontSize: 11, fontFamily: 'Inter_600SemiBold', color: Colors.success },
  broken: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.error, lineHeight: 19, marginBottom: 10 },
  blurb: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text2, lineHeight: 19, marginBottom: 12 },
  consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  consentRowLocked: { opacity: 0.55 },
  box: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: Colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  boxOn: { backgroundColor: Colors.brand, borderColor: Colors.brand },
  consentText: { flex: 1, fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text2, lineHeight: 19 },
  consentLead: { fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  hint: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3, lineHeight: 17, marginBottom: 10 },
  connectBlock: { marginTop: 2 },
  disconnectBtn: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.button,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginTop: 4,
  },
  disconnectText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: Colors.text2 },
  error: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.error, marginTop: 10 },
});
