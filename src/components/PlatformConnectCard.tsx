import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { PlatformConnection } from '../types';
import { creators as creatorsApi } from '../lib/api';
import { connectPlatform } from '../lib/creatorConnect';
import Card from './ui/Card';
import Button from './ui/Button';
import { Badge, Note, OutlineButton, ui } from './creatorUi';

// ─────────────────────────────────────────────────────────────────────────────
// PlatformConnectCard: connect an Instagram or TikTok account (MEAL-82 / 83)
//
// The mobile port of the web portal's card. Connecting lets Mealio **read**
// what the creator posted and nothing else, so unlike YouTube there is no
// second consent. What the two platforms do need saying differently is the
// honest limit of each: Instagram gives us the caption, TikTok the description,
// and a recipe that is only spoken is out of reach on both.
//
// Connecting runs the platform's consent screen in the system browser and comes
// back to the app (lib/creatorConnect.ts). Embedded in the sync section the
// pitch and the disconnect button belong to the section, as on the web.
// ─────────────────────────────────────────────────────────────────────────────

type SocialPlatform = 'instagram' | 'tiktok';

interface CardCopy {
  label: string;
  pitch: string;
  button: string;
  connectedNote: string;
  buttonColor: string;
  showExpiry: boolean;
}

const COPY: Record<SocialPlatform, CardCopy> = {
  instagram: {
    label: 'Instagram',
    pitch:
      'Connecting lets Mealio read the captions on your posts and Reels, so a recipe you have already written ' +
      'out can be imported instead of typed again. We cannot read what is only spoken in a video, so if your ' +
      'recipe lives in the voiceover rather than the caption, this will find very little. Instagram also ' +
      'requires a Professional (Business or Creator) account; personal accounts get no access at all.',
    button: 'Connect Instagram',
    connectedNote:
      'Mealio reads the captions on this account to import recipes from them. Nothing on your account is ever ' +
      'edited.',
    buttonColor: '#DB2777',
    showExpiry: true,
  },
  tiktok: {
    label: 'TikTok',
    pitch:
      'Connecting lets Mealio read the descriptions on your videos, so a recipe you have written out there can ' +
      'be imported instead of typed again. TikTok gives apps the description and nothing else, no video file ' +
      'and no transcript, so if your recipes are spoken rather than written, there is nothing here for us to ' +
      'read, and that is a limit of TikTok rather than something we can improve.',
    button: 'Connect TikTok',
    connectedNote:
      'Mealio reads the descriptions on this account to import recipes from them. Nothing on your account is ' +
      'ever edited.',
    buttonColor: '#111827',
    showExpiry: false,
  },
};

function formatExpiry(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

interface Props {
  platform: SocialPlatform;
  embedded?: boolean;
  /** Told whether a usable account is connected, every time the card learns it. */
  onConnectionChange?: (connected: boolean) => void;
  /** Told when a connect round trip from this card has just succeeded. */
  onConnected?: () => void;
  /** Shown above the button: what to expect from pressing it. */
  note?: string | null;
}

export default function PlatformConnectCard({ platform, embedded = false, onConnectionChange, onConnected, note }: Props) {
  const copy = COPY[platform];
  const [status, setStatus] = useState<PlatformConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const changeRef = useRef(onConnectionChange);
  changeRef.current = onConnectionChange;

  const load = useCallback(async () => {
    try {
      const next = await creatorsApi.connections.status(platform);
      if (!mounted.current) return;
      setStatus(next);
      changeRef.current?.(next.connected && !next.brokenReason);
    } catch {
      // Says nothing rather than guess at a connection.
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [platform]);

  useEffect(() => { void load(); }, [load]);

  async function connect() {
    setBusy(true);
    setError('');
    setNotice('');
    const outcome = await connectPlatform(platform);
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

  function disconnect() {
    Alert.alert(`Disconnect ${copy.label}?`, `Mealio stops reading your ${copy.label} and forgets the connection.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          setError('');
          try {
            await creatorsApi.connections.disconnect(platform);
            await load();
          } catch (err: any) {
            if (mounted.current) setError(err?.message || `Could not disconnect that ${copy.label} account.`);
          } finally {
            if (mounted.current) setBusy(false);
          }
        },
      },
    ]);
  }

  if (loading || !status) return null;

  const expiry = copy.showExpiry ? formatExpiry(status.expiresAt) : null;
  const unconfigured = status.configured === false;

  const body = (
    <>
      {(status.connected || !embedded) && (
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            {!embedded && <Text style={ui.eyebrow}>{copy.label.toUpperCase()}</Text>}
            <Text style={ui.title}>
              {status.connected
                ? status.account?.name
                  ? `@${status.account.name}`
                  : 'Connected account'
                : 'Connect your account'}
            </Text>
          </View>
          {status.connected && !status.brokenReason && (
            <Badge label="Connected" tone="green" testID={`${platform}-connected`} />
          )}
        </View>
      )}

      {!!notice && <Text style={[ui.hint, styles.gap]} testID={`${platform}-cancelled`}>{notice}</Text>}

      {!!status.brokenReason && (
        <Text style={[ui.error, styles.gap]}>
          Your {copy.label} connection stopped working: {status.brokenReason} Reconnect to carry on importing.
        </Text>
      )}

      {!status.connected || status.brokenReason ? (
        <>
          {!embedded && <Text style={[ui.body, styles.gapLg]}>{copy.pitch}</Text>}

          {!!note && !unconfigured && (
            <View style={styles.gapLg}>
              <Note testID={`note-${platform}`}>{note}</Note>
            </View>
          )}

          {unconfigured ? (
            <Note testID={`unconfigured-${platform}`}>
              {copy.label} syncing is not switched on here yet. Nothing is wrong with your account. Get in touch and
              we will tell you when it is ready.
            </Note>
          ) : (
            <Button
              label={busy ? `Opening ${copy.label}…` : copy.button}
              onPress={() => { void connect(); }}
              disabled={busy}
              style={{ backgroundColor: copy.buttonColor }}
              testID={`${platform}-connect`}
            />
          )}
          {!unconfigured && (
            <Text style={[ui.hint, styles.small]}>
              We only ask for permission to read your own posts. Nothing is posted, edited or deleted on your
              account, and you can disconnect at any time.
            </Text>
          )}
        </>
      ) : (
        <>
          {!embedded && <Text style={[ui.body, styles.gapLg]}>{copy.connectedNote}</Text>}
          {!!expiry && (
            <Text style={[ui.hint, styles.gapLg]}>
              This connection renews itself automatically, and lasts until {expiry} if it does not.
            </Text>
          )}
          {!embedded && (
            <OutlineButton label={`Disconnect ${copy.label}`} onPress={disconnect} disabled={busy} />
          )}
        </>
      )}

      {!!error && <Text style={[ui.error, styles.errorGap]} testID={`${platform}-error`}>{error}</Text>}
    </>
  );

  if (embedded) return <View testID={`${platform}-connect-card`}>{body}</View>;
  return <Card style={styles.card}><View testID={`${platform}-connect-card`}>{body}</View></Card>;
}

const styles = StyleSheet.create({
  card: { marginBottom: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10, gap: 8 },
  headerText: { flex: 1, minWidth: 0 },
  gap: { marginBottom: 10 },
  gapLg: { marginBottom: 12 },
  small: { marginTop: 8 },
  errorGap: { marginTop: 10 },
});
