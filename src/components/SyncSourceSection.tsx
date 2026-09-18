import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, Alert } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Colors, Radius } from '../constants/colors';
import type { CatalogEntry, CatalogResult, Creator, SyncRun, SyncRunTotals } from '../types';
import { creators as creatorsApi } from '../lib/api';
import { useCreatorDrafts } from '../context/CreatorDraftsContext';
import {
  checkPlatformLink,
  creatorSourceBlockedReason,
  CREATOR_SELECTION_MAX,
  CREATOR_SOURCE_OPTIONS,
  isWebsiteReady,
  SOURCE_LABELS,
  type PlatformSource,
  type PrimarySource,
} from '../constants/creatorSources';
import Card from './ui/Card';
import Button from './ui/Button';
import YouTubeConnectCard from './YouTubeConnectCard';
import PlatformConnectCard from './PlatformConnectCard';
import { Badge, Note, OutlineButton, ui } from './creatorUi';

// ─────────────────────────────────────────────────────────────────────────────
// SyncSourceSection: "Sync your content with Mealio" (MEAL-101)
//
// The mobile port of the web portal's component of the same name, logic first.
// One picker, one body, and the back catalogue once a source is readable.
//
//   • The promise is on the screen before any control: whatever a creator posts
//     from then on syncs automatically and comes back as a draft.
//   • The first poll baselines. Nothing already published is imported on its
//     own, which is why the "What you have already posted" checklist exists.
//   • Mealio reads one place. Switching source keeps the old grant but stops
//     reading it, and that is said out loud at the moment of the switch.
//   • The choice takes effect as soon as it can: on selection when the source
//     is ready, on connection when it is not. Never on a page load: `chose`
//     keeps opening the screen from writing anything.
//
// Deliberately different from the web, for a phone:
//   • The picker is a list of four rows rather than a dropdown.
//   • The catalogue asks for its next window with a button rather than on
//     scroll; the list sits inside the page's own scroll, not a box of its own.
//   • Import sends every ticked post, including any a filter is hiding. The web
//     sends only the visible ones, which made "Import 12 posts" import fewer.
//   • Disconnect asks once before it revokes anything.
// ─────────────────────────────────────────────────────────────────────────────

type SectionRow = Pick<
  Creator,
  'websiteUrl' | 'youtubeUrl' | 'instagramUrl' | 'tiktokUrl' | 'feedUrl' | 'primarySource' | 'importOptIn'
>;

interface Props {
  creator: Creator;
  /** Rendered above the section: the profile card, as on the web's left column. */
  children?: React.ReactNode;
  /** Handed the fields that changed, so the portal's own copy stays in step. */
  onSaved?: (changes: Partial<Creator>) => void;
  /**
   * Bumped by the portal whenever a meal is published or deleted. Deleting a
   * meal withdraws the post it came from, which un-greys a row here.
   */
  mealsVersion?: number;
}

/** The states a post can be in, as a creator would name them. */
export const FILTER_STATES: Array<{ key: string; label: string }> = [
  { key: 'new', label: 'Not imported' },
  { key: 'importing', label: 'Importing' },
  { key: 'imported', label: 'Already Imported' },
  { key: 'withdrawn', label: 'Withdrawn' },
  { key: 'declined', label: 'Declined' },
  { key: 'rejected', label: 'No recipe found' },
  { key: 'failed', label: 'Could not read' },
];

/** Between worker calls while a run is unfinished. */
const POLL_DELAY_MS = 750;
/** How often the run is re-read while a chunk is still working. */
const RUN_WATCH_MS = 1_500;
/** Chunks one press of Import will drive before asking for Carry on. */
const MAX_CHUNKS = 120;

function formatDate(value: string | null): string {
  if (!value) return '';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString() : '';
}

/** The server's own sentence off a refusal, or the fallback. */
function serverError(err: any, fallback: string): string {
  return (typeof err?.body?.error === 'string' && err.body.error) || fallback;
}

/**
 * The source to open on. A source the picker can show is shown; a blocked one
 * opens unanswered; nothing chosen yet opens on Website, where an unaided
 * creator can get themselves working. Opening there claims nothing.
 */
function storedSource(creator: SectionRow): PrimarySource {
  const stored = creator.primarySource;
  if (stored === 'website' || stored === 'youtube' || stored === 'instagram' || stored === 'tiktok') {
    return creatorSourceBlockedReason(stored) ? 'none' : stored;
  }
  return 'website';
}

function rowOf(creator: Creator): SectionRow {
  return {
    websiteUrl: creator.websiteUrl ?? null,
    youtubeUrl: creator.youtubeUrl ?? null,
    instagramUrl: creator.instagramUrl ?? null,
    tiktokUrl: creator.tiktokUrl ?? null,
    feedUrl: creator.feedUrl ?? null,
    primarySource: creator.primarySource ?? null,
    importOptIn: creator.importOptIn ?? null,
  };
}

export default function SyncSourceSection({ creator, children, onSaved, mealsVersion = 0 }: Props) {
  const { refresh: refreshDrafts } = useCreatorDrafts();
  const [row, setRow] = useState<SectionRow>(() => rowOf(creator));
  const [source, setSource] = useState<PrimarySource>(() => storedSource(rowOf(creator)));

  const [websiteInput, setWebsiteInput] = useState(creator.websiteUrl ?? '');
  // Show the address already on the row, but only into an empty box, so it can
  // never overwrite something being typed.
  useEffect(() => {
    const known = creator.websiteUrl || row.websiteUrl;
    if (known && !websiteInput) setWebsiteInput(known);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creator.websiteUrl, row.websiteUrl]);
  const [websiteBusy, setWebsiteBusy] = useState(false);
  const [websiteError, setWebsiteError] = useState('');
  const [websiteDetail, setWebsiteDetail] = useState('');

  /** Per platform, and unknown until that platform's card has said. Never inferred from a link. */
  const [connected, setConnected] = useState<Partial<Record<PlatformSource, boolean>>>({});
  const noteConnection = (platform: PlatformSource) => (is: boolean) =>
    setConnected((current) => (current[platform] === is ? current : { ...current, [platform]: is }));

  /** The source being synced from before this switch, if any. */
  const [left, setLeft] = useState<PlatformSource | null>(null);

  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  /** Which source the loaded catalogue belongs to. */
  const [catalogFor, setCatalogFor] = useState<PrimarySource | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /** A further window failed, so nothing asks for it again until Try again. */
  const [moreFailed, setMoreFailed] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const [run, setRun] = useState<SyncRun | null>(null);
  const [totals, setTotals] = useState<SyncRunTotals | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  /** Bumped when a connect round trip succeeds, so the choice is written then. */
  const [connectNonce, setConnectNonce] = useState(0);

  const mounted = useRef(true);
  /** True once the creator has actually chosen something on this screen. */
  const chose = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const ready =
    source === 'website'
      ? isWebsiteReady(row)
      : source === 'none'
        ? false
        : connected[source] === true;

  const syncingFromThis = row.importOptIn === true && row.primarySource === source;
  const label = source === 'none' ? '' : SOURCE_LABELS[source];

  const applyChanges = (changes: Partial<SectionRow>) => {
    setRow((current) => ({ ...current, ...changes }));
    onSaved?.(changes);
  };

  /** Puts the creator's choice on the row. */
  const chooseSource = async (next: PrimarySource) => {
    setSwitching(true);
    setError('');
    try {
      await creatorsApi.setPrimarySource(next);
      if (!mounted.current) return;
      setSwitching(false);
      applyChanges({ primarySource: next, importOptIn: next !== 'none' });
    } catch (err: any) {
      if (!mounted.current) return;
      setSwitching(false);
      setError(serverError(err, 'Could not change where Mealio syncs from.'));
    }
  };

  /**
   * Stop syncing and forget the connection it was reading. Revocation first,
   * and a failure there stops everything: saying "disconnected" while the token
   * is still live is the one error a creator would never think to check.
   */
  const disconnect = async () => {
    if (source === 'none') return;
    const was = source;
    setDisconnecting(true);
    setError('');

    if (was !== 'website') {
      try {
        await creatorsApi.connections.disconnect(was);
      } catch (err: any) {
        if (!mounted.current) return;
        setDisconnecting(false);
        setError(serverError(err, `We could not disconnect your ${SOURCE_LABELS[was]}. It is still connected. Please try again.`));
        return;
      }
      if (!mounted.current) return;
      setConnected((current) => ({ ...current, [was]: false }));
    }

    try {
      await creatorsApi.setPrimarySource('none', { clearWebsite: was === 'website' });
    } catch (err: any) {
      if (!mounted.current) return;
      setDisconnecting(false);
      setError(serverError(err, 'We stopped reading your account, but could not save the change. Please try again.'));
      return;
    }
    if (!mounted.current) return;
    setDisconnecting(false);

    applyChanges({
      primarySource: 'none',
      importOptIn: false,
      ...(was === 'website' ? { websiteUrl: null, feedUrl: null } : {}),
    });

    chose.current = false;
    setSource('none');
    setLeft(null);
    setWebsiteInput('');
    setCatalog(null);
    setCatalogFor(null);
    setSelected([]);
    setRun(null);
    setTotals(null);
  };

  const confirmDisconnect = () => {
    Alert.alert(
      `Disconnect ${label}?`,
      `Mealio stops reading your ${label} and forgets the connection. Recipes you have already published stay exactly where they are.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Disconnect', style: 'destructive', onPress: () => { void disconnect(); } },
      ],
    );
  };

  const pickSource = (next: PrimarySource) => {
    if (next === source) return;
    chose.current = true;
    // Only a real switch warns: correcting an answer nobody had acted on yet is
    // not one, and a warning for changing your mind teaches people to skip it.
    if (row.importOptIn === true && row.primarySource && row.primarySource !== 'none' && row.primarySource !== next) {
      setLeft(row.primarySource as PlatformSource);
    }
    setSource(next);
    // Nothing about the old source survives the switch.
    setCatalog(null);
    setCatalogFor(null);
    setSelected([]);
    setRun(null);
    setTotals(null);
    setMoreFailed(false);
    setError('');
    setWebsiteError('');
    setWebsiteDetail('');
  };

  const onConnected = () => {
    chose.current = true;
    setConnectNonce((n) => n + 1);
  };

  // The choice takes effect as soon as it can, and only after a touch.
  useEffect(() => {
    if (switching || !chose.current) return;
    if (source === 'none') {
      if (row.primarySource !== 'none' || row.importOptIn === true) void chooseSource('none');
      return;
    }
    if (!ready) return;
    if (row.primarySource === source && row.importOptIn === true) return;
    void chooseSource(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, source, row.primarySource, row.importOptIn, connectNonce]);

  const nextPageToken = catalog?.ok ? catalog.nextPageToken ?? null : null;

  const loadCatalog = async (cursor: string | null = null) => {
    const forSource = source;
    if (forSource === 'none') return;
    if (cursor === null) setLoadingCatalog(true); else setLoadingMore(true);
    setError('');
    let next: CatalogResult;
    try {
      next = await creatorsApi.sync.catalog(forSource, cursor);
    } catch (err: any) {
      if (!mounted.current) return;
      if (cursor === null) setLoadingCatalog(false); else setLoadingMore(false);
      setError(serverError(err, 'Could not read what you have published.'));
      if (cursor !== null) setMoreFailed(true);
      return;
    }
    if (!mounted.current) return;
    if (cursor === null) setLoadingCatalog(false); else setLoadingMore(false);
    if (cursor === null) setCatalogFor(forSource);
    setCatalog((current) => {
      if (cursor === null || !current?.ok || !next.ok) return next;
      // Appended and de-duplicated: a post made while paging shifts the window.
      const seen = new Set(current.entries.map((entry) => entry.itemId));
      const fresh = next.entries.filter((entry) => !seen.has(entry.itemId));
      // A window that adds nothing is the end of the list, whatever it says.
      if (fresh.length === 0) return { ...current, nextPageToken: null };
      return { ...next, entries: [...current.entries, ...fresh] };
    });
  };

  // Re-read the checklist when a meal is published or deleted.
  const firstMealsVersion = useRef(mealsVersion);
  useEffect(() => {
    if (mealsVersion === firstMealsVersion.current) return;
    if (catalogFor === source) void loadCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mealsVersion]);

  // Drawn as soon as there is something to draw, and started alongside the
  // connection check when the row already says this source is being synced.
  useEffect(() => {
    const believedConnected = source !== 'none' && row.primarySource === source && row.importOptIn === true;
    const stale = catalog !== null && catalogFor !== source;
    if ((ready || believedConnected) && (!catalog || stale) && !loadingCatalog) void loadCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, source, row.feedUrl, catalog, catalogFor]);

  const saveWebsite = async () => {
    setWebsiteError('');
    setWebsiteDetail('');
    // The same rule the server uses, only to catch a typo before a round trip
    // that takes several seconds.
    const check = checkPlatformLink('website', websiteInput);
    if (!check.ok) { setWebsiteError(check.error); return; }
    if (!websiteInput.trim()) { setWebsiteError('Type the address of your website or blog, then press Save.'); return; }

    setWebsiteBusy(true);
    try {
      const result = await creatorsApi.checkWebsite(websiteInput);
      if (!mounted.current) return;
      if (result.ok !== true) {
        setWebsiteError((result as { error?: string }).error || 'We could not check that site. Try again.');
        return;
      }
      setWebsiteInput(result.websiteUrl);
      setWebsiteDetail(result.detail ?? '');
      applyChanges({
        websiteUrl: result.websiteUrl,
        feedUrl: result.feedUrl,
        primarySource: 'website',
        importOptIn: true,
      });
      // The catalogue is now a different site's.
      setCatalog(null);
      setSelected([]);
    } catch (err: any) {
      if (mounted.current) setWebsiteError(serverError(err, 'We could not check that site. Try again.'));
    } finally {
      if (mounted.current) setWebsiteBusy(false);
    }
  };

  const allEntries: CatalogEntry[] = catalog?.ok ? catalog.entries : [];

  const [visibleStates, setVisibleStates] = useState<Set<string>>(() => new Set(FILTER_STATES.map((f) => f.key)));
  const [filterOpen, setFilterOpen] = useState(false);

  const stateOf = (entry: CatalogEntry): string => {
    if (entry.record?.inFlight === true) return 'importing';
    const status = entry.record?.status;
    if (status === 'imported') return 'imported';
    if (status === 'declined') return 'declined';
    if (status === 'rejected') return 'rejected';
    if (status === 'withdrawn') return 'withdrawn';
    if (status === 'failed') return 'failed';
    return 'new';
  };

  const entries = allEntries.filter((entry) => visibleStates.has(stateOf(entry)));
  const hiddenCount = allEntries.length - entries.length;

  const isImported = (entry: CatalogEntry) => entry.record?.status === 'imported';
  /** Refused by the gate, or declined in review. Still tickable, one at a time. */
  const isRejected = (entry: CatalogEntry) =>
    entry.record?.status === 'rejected' || entry.record?.status === 'declined';
  const wasDeclined = (entry: CatalogEntry) => entry.record?.status === 'declined';
  const isWithdrawn = (entry: CatalogEntry) => entry.record?.status === 'withdrawn';
  const isFailed = (entry: CatalogEntry) => entry.record?.status === 'failed' && !entry.record?.inFlight;
  const isImporting = (entry: CatalogEntry) => entry.record?.inFlight === true;
  /** What "Tick the newest" ticks: never an imported post, never a refused one. */
  const importable = (entry: CatalogEntry) => !isImported(entry) && !isRejected(entry);
  const unimported = entries.filter(importable);
  const atCap = selected.length >= CREATOR_SELECTION_MAX;

  const toggle = (itemId: string) => {
    setSelected((current) => {
      if (current.includes(itemId)) return current.filter((id) => id !== itemId);
      // The cap holds at the tick rather than at the button.
      if (current.length >= CREATOR_SELECTION_MAX) return current;
      return [...current, itemId];
    });
  };

  const selectAllNew = () => setSelected(unimported.slice(0, CREATOR_SELECTION_MAX).map((entry) => entry.itemId));

  /** Read the run while a chunk works. Display only; a dropped read is a missed frame. */
  const readRun = async (runId: string) => {
    try {
      const data = await creatorsApi.sync.read(runId);
      if (!mounted.current || !data?.run) return;
      setRun(data.run);
      if (data.totals) setTotals(data.totals);
    } catch {
      // The next read carries the same state.
    }
  };

  /** Drives the worker until the run stops moving. The run lives on the server. */
  const drive = async (runId: string) => {
    for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
      const timer = setInterval(() => { void readRun(runId); }, RUN_WATCH_MS);
      let data: { run: SyncRun; totals: SyncRunTotals };
      try {
        data = await creatorsApi.sync.advance(runId);
      } catch (err: any) {
        clearInterval(timer);
        if (!mounted.current) return;
        // Usually the chunk running out of time. Everything finished is saved.
        await readRun(runId);
        if (!mounted.current) return;
        setError(serverError(
          err,
          'That is as far as this run got in one go. Everything read so far is saved. Press Carry on to finish it.',
        ));
        return;
      }
      clearInterval(timer);
      if (!mounted.current) return;
      setRun(data.run);
      setTotals(data.totals);
      if (data.run.status === 'done') {
        // The checklist and the drafts badge were both read before any of this.
        void loadCatalog();
        void refreshDrafts();
        return;
      }
      if (data.run.status === 'running') {
        setError('This import is already running somewhere else: on the website, or Mealio finishing it off.');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_DELAY_MS));
      if (!mounted.current) return;
    }
    setError('That import is taking a while. It is saved. Press Carry on to keep going.');
  };

  const startImport = async () => {
    if (busy || selected.length === 0 || source === 'none') return;
    setBusy(true);
    setError('');
    setRun(null);
    setTotals(null);

    let created: SyncRun;
    try {
      const data = await creatorsApi.sync.start(
        source,
        allEntries
          .filter((entry) => selected.includes(entry.itemId))
          // `reselect` on a post already refused or declined: the server reads
          // those again only when asked, and here only a tick of its own asks.
          .map((entry) => ({
            itemId: entry.itemId,
            url: entry.url,
            title: entry.title,
            publishedAt: entry.publishedAt,
            ...(isRejected(entry) ? { reselect: true as const } : {}),
          })),
      );
      created = data.run;
    } catch (err: any) {
      if (!mounted.current) return;
      setBusy(false);
      setError(serverError(err, 'Could not start that import.'));
      // One run at a time: the refusal brings the run back, which puts Carry on
      // in front of the creator.
      if (err?.status === 409 && err?.body?.run) {
        setRun(err.body.run as SyncRun);
        if (err.body.totals) setTotals(err.body.totals as SyncRunTotals);
      }
      return;
    }
    if (!mounted.current) return;
    setRun(created);
    await drive(created.id);
    if (mounted.current) setBusy(false);
  };

  const resume = async () => {
    if (!run || busy) return;
    setBusy(true);
    setError('');
    await drive(run.id);
    if (mounted.current) setBusy(false);
  };

  const hasCatalogue = (ready && catalogFor === source) || Boolean(run);

  return (
    <View>
      {children}

      <Card style={styles.card}>
        <View testID="sync-source-section">
          <Text style={ui.eyebrow}>YOUR RECIPES</Text>
          <Text style={[ui.title, styles.titleGap]}>Sync your content with Mealio</Text>
          <Text style={[ui.body, styles.gapLg]}>
            Tell Mealio where you publish and we will keep watching it.{' '}
            <Text style={ui.strong}>
              Whatever you post from then on syncs automatically and comes back to you as a draft to review
            </Text>
            .
          </Text>

          <Text style={ui.label}>WHERE YOU PUBLISH</Text>
          {source === 'none' && (
            <Text style={[ui.hint, styles.gap]} testID="source-unanswered">Choose where you publish…</Text>
          )}
          <View style={styles.options} accessibilityRole="radiogroup">
            {CREATOR_SOURCE_OPTIONS.map((option, i) => {
              const on = source === option.source;
              const disabled = switching || busy || Boolean(option.blockedReason);
              return (
                <TouchableOpacity
                  key={option.source}
                  onPress={() => pickSource(option.source)}
                  disabled={disabled}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on, disabled }}
                  testID={`source-option-${option.source}`}
                  style={[styles.option, i > 0 && styles.optionBorder, disabled && !on && ui.disabled]}
                  activeOpacity={0.8}
                >
                  <View style={[styles.radio, on && styles.radioOn]}>{on && <View style={styles.radioDot} />}</View>
                  <View style={styles.flex}>
                    <Text style={[styles.optionLabel, on && styles.optionLabelOn]}>{option.label}</Text>
                    {!!option.blockedReason && <Text style={ui.hint}>{option.blockedReason}</Text>}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          {!!error && <Text style={[ui.error, styles.top]} testID="sync-error" accessibilityRole="alert">{error}</Text>}

          {/* What switching costs: the old account stays connected, and nothing
              else on this screen would ever mention it again. */}
          {left && left !== source && (
            <View style={styles.top} testID="switch-warning">
              <Note>
                Mealio now syncs from {source === 'none' ? 'nowhere' : SOURCE_LABELS[source]} only.{' '}
                <Text style={styles.noteStrong}>Anything new you post to {SOURCE_LABELS[left]} will not be imported.</Text>{' '}
                Your {SOURCE_LABELS[left]} account stays connected, and recipes already published on Mealio stay
                exactly where they are.
              </Note>
            </View>
          )}

          <View style={ui.divider}>
            {source === 'none' ? (
              <Text style={ui.body} testID="sync-off">
                Mealio is not reading anything you publish. Pick where you publish above whenever you would like it to
                start. Recipes already published on Mealio stay exactly where they are.
              </Text>
            ) : source === 'website' ? (
              <View testID="website-panel">
                <Text style={[ui.strong, styles.fieldTitle]}>Your website or blog</Text>
                <Text style={[ui.body, styles.gap]}>
                  Paste the address and press Save. Mealio reads a few of your recent posts to check it can actually
                  pull recipes out of them. This can take up to 30 seconds.
                </Text>
                <TextInput
                  value={websiteInput}
                  onChangeText={(text) => { setWebsiteInput(text); setWebsiteError(''); setWebsiteDetail(''); }}
                  placeholder="chefsarah.com"
                  placeholderTextColor={Colors.text3}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  editable={!websiteBusy}
                  style={[styles.input, websiteBusy && ui.disabled]}
                  testID="website-input"
                  accessibilityLabel="Your website or blog"
                />
                <Button
                  label={websiteBusy ? 'Checking your site…' : 'Save'}
                  onPress={() => { void saveWebsite(); }}
                  disabled={websiteBusy}
                  size="sm"
                  style={styles.saveButton}
                  testID="website-save"
                />
                {!!websiteError && (
                  <Text style={[ui.error, styles.top]} testID="website-error" accessibilityRole="alert">{websiteError}</Text>
                )}
                {!!websiteDetail && <Text style={[ui.success, styles.top]} testID="website-detail">{websiteDetail}</Text>}
              </View>
            ) : source === 'youtube' ? (
              <YouTubeConnectCard embedded onConnectionChange={noteConnection('youtube')} onConnected={onConnected} />
            ) : (
              <PlatformConnectCard
                key={source}
                platform={source}
                embedded
                note={CREATOR_SOURCE_OPTIONS.find((option) => option.source === source)?.note ?? null}
                onConnectionChange={noteConnection(source)}
                onConnected={onConnected}
              />
            )}
          </View>

          {/* Where it stands, and the off switch once there is something to switch off. */}
          {(syncingFromThis || ready) && (
            <View style={ui.divider} testID="sync-live">
              {syncingFromThis && (
                <Text style={[ui.body, styles.gap]} testID="sync-status">
                  Mealio is syncing from your {label}. New posts come back to you as drafts.
                </Text>
              )}
              <OutlineButton
                label={disconnecting ? 'Disconnecting…' : `Disconnect ${label}`}
                onPress={confirmDisconnect}
                disabled={switching || disconnecting || busy}
                testID="sync-disconnect"
              />
              <Text style={[ui.hint, styles.small]}>
                Mealio stops reading your {label} and forgets the connection. Recipes you have already published stay
                exactly where they are.
                {source === 'youtube'
                  ? ' The permission itself stays on your Google Account until you remove it at myaccount.google.com/permissions.'
                  : ''}
              </Text>
            </View>
          )}
        </View>
      </Card>

      {hasCatalogue && (
        <>
          {ready && catalogFor === source && (
            <Card style={styles.card}>
              <View testID="catalogue">
                <Text style={ui.subtitle}>What you have already posted</Text>
                <Text style={[ui.body, styles.gapLg]}>
                  Syncing starts from today: <Text style={ui.strong}>nothing you posted before now is imported on its
                  own</Text>. Tick anything from your back catalogue you would like as a draft too, up to{' '}
                  {CREATOR_SELECTION_MAX} at a time.
                </Text>

                {loadingCatalog && <Text style={ui.hint}>Reading what you have published…</Text>}

                {catalog && !catalog.ok && <Note testID="catalogue-unavailable">{catalog.detail}</Note>}

                {catalog?.ok && allEntries.length > 0 && (
                  <>
                    <View style={styles.toolbar}>
                      <Text
                        style={[styles.count, atCap && styles.countCap]}
                        testID="selection-count"
                      >
                        {selected.length} of {CREATOR_SELECTION_MAX} chosen
                      </Text>
                      <OutlineButton
                        label={`Tick the ${Math.min(unimported.length, CREATOR_SELECTION_MAX)} newest`}
                        onPress={selectAllNew}
                        testID="tick-newest"
                      />
                      <OutlineButton
                        label={hiddenCount > 0 ? `Filter · ${hiddenCount} hidden` : 'Filter'}
                        onPress={() => setFilterOpen((open) => !open)}
                        testID="filter-toggle"
                      />
                      {selected.length > 0 && (
                        <OutlineButton label="Clear" onPress={() => setSelected([])} testID="clear-selection" />
                      )}
                    </View>

                    {filterOpen && (
                      <View style={styles.filterMenu} testID="filter-menu">
                        {FILTER_STATES.map((state) => {
                          const on = visibleStates.has(state.key);
                          return (
                            <TouchableOpacity
                              key={state.key}
                              style={styles.filterRow}
                              accessibilityRole="checkbox"
                              accessibilityState={{ checked: on }}
                              testID={`filter-${state.key}`}
                              onPress={() => setVisibleStates((current) => {
                                const next = new Set(current);
                                // Never all off: an empty list looks like the source went away.
                                if (next.has(state.key) && next.size > 1) next.delete(state.key);
                                else next.add(state.key);
                                return next;
                              })}
                            >
                              <View style={[ui.checkbox, on && ui.checkboxOn]}>
                                {on && <Feather name="check" size={14} color="#fff" />}
                              </View>
                              <Text style={ui.body}>{state.label}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    )}

                    {atCap && (
                      <Text style={[styles.capText, styles.gap]} testID="cap-reached">
                        That is the {CREATOR_SELECTION_MAX} we can do in one go. Import these, then come back for the
                        rest.
                      </Text>
                    )}

                    <View style={styles.list}>
                      {entries.map((entry, i) => {
                        const already = isImported(entry);
                        const rejected = isRejected(entry);
                        const declined = wasDeclined(entry);
                        // Nothing to tick on an imported post or one importing now.
                        const settled = already || isImporting(entry);
                        const checked = selected.includes(entry.itemId);
                        const disabled = settled || (!checked && atCap);
                        return (
                          <TouchableOpacity
                            key={entry.itemId}
                            onPress={() => toggle(entry.itemId)}
                            disabled={disabled}
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked, disabled }}
                            accessibilityLabel={entry.title || entry.url}
                            testID={`catalogue-row-${entry.itemId}`}
                            style={[styles.entry, i > 0 && styles.entryBorder, settled && styles.entrySettled]}
                            activeOpacity={0.8}
                          >
                            <View style={[ui.checkbox, checked && ui.checkboxOn, disabled && ui.disabled]}>
                              {checked && <Feather name="check" size={14} color="#fff" />}
                            </View>
                            <View style={styles.flex}>
                              <Text style={styles.entryTitle} numberOfLines={2}>{entry.title || entry.url}</Text>
                              {!!formatDate(entry.publishedAt) && <Text style={ui.hint}>{formatDate(entry.publishedAt)}</Text>}
                              <View style={styles.badges}>
                                {already && <Badge label="Already Imported" tone="green" />}
                                {isWithdrawn(entry) && <Badge label="Withdrawn" tone="white" testID="withdrawn" />}
                                {isImporting(entry) && <Badge label="Importing…" tone="amber" testID="importing" />}
                                {isFailed(entry) && <Badge label="Could not read" tone="amber" testID="unreadable" />}
                                {rejected && (
                                  <Badge
                                    label={declined ? 'Declined' : 'No recipe found'}
                                    tone="gray"
                                    testID={declined ? 'declined' : 'not-a-recipe'}
                                  />
                                )}
                              </View>
                              {isWithdrawn(entry) && (
                                <Text style={ui.hint}>You imported this before and deleted the meal. Tick it to import it again.</Text>
                              )}
                              {(rejected || isFailed(entry)) && !!entry.record?.detail && (
                                <Text style={ui.hint}>{entry.record.detail}</Text>
                              )}
                            </View>
                          </TouchableOpacity>
                        );
                      })}

                      {nextPageToken && !moreFailed && (
                        <View style={styles.more} testID={hiddenCount > 0 ? 'catalogue-more-filtered' : 'catalogue-more'}>
                          {hiddenCount > 0 && (
                            <Text style={ui.hint}>Showing {entries.length} of {allEntries.length} read so far.</Text>
                          )}
                          <OutlineButton
                            label={loadingMore ? 'Reading more…' : hiddenCount > 0 ? 'Read more from your site' : 'Show more'}
                            onPress={() => { void loadCatalog(nextPageToken); }}
                            disabled={loadingMore}
                            testID="load-more"
                          />
                        </View>
                      )}
                      {moreFailed && (
                        <View style={styles.more}>
                          <Text style={ui.hint}>We could not read any more of your posts.</Text>
                          <OutlineButton
                            label="Try again"
                            onPress={() => { setMoreFailed(false); void loadCatalog(nextPageToken); }}
                          />
                        </View>
                      )}
                    </View>

                    <Button
                      label={
                        busy
                          ? 'Importing…'
                          : selected.length === 0
                            ? 'Import posts'
                            : `Import ${selected.length} ${selected.length === 1 ? 'post' : 'posts'}`
                      }
                      onPress={() => { void startImport(); }}
                      disabled={busy || selected.length === 0}
                      style={styles.importButton}
                      testID="import-button"
                    />
                    <Text style={[ui.hint, styles.small]}>These arrive as drafts too. Nothing is published without you.</Text>
                  </>
                )}

                {catalog?.ok && entries.length === 0 && (
                  <Text style={ui.body}>
                    We could not see anything published on your {label} yet. New posts will still sync from now on.
                  </Text>
                )}
              </View>
            </Card>
          )}

          {run && (
            <Card style={styles.card}>
              <View testID="run-summary">
                <View style={styles.runHeader}>
                  <Text style={[ui.subtitle, styles.flex]}>{run.status === 'done' ? 'Import finished' : 'Importing…'}</Text>
                  {run.status !== 'done' && !busy && (
                    <OutlineButton label="Carry on" onPress={() => { void resume(); }} testID="carry-on" />
                  )}
                </View>
                {totals && (
                  <Text style={ui.body} testID="run-totals">
                    Chose {totals.selected} · <Text style={ui.strong}>{totals.drafted}</Text> waiting in your review queue
                    {totals.rejected > 0
                      ? ` · ${totals.rejected} did not look like a recipe, so we left ${totals.rejected === 1 ? 'it' : 'them'} alone`
                      : ''}
                    {totals.skipped > 0 ? ` · ${totals.skipped} already imported` : ''}
                    {totals.failed > 0 ? ` · ${totals.failed} we could not read` : ''}
                    {totals.pending > 0 ? ` · ${totals.pending} still to go` : ''}
                  </Text>
                )}

                <View style={[styles.list, styles.top]} testID="run-queue">
                  {run.items.map((item, i) => {
                    const working = run.status !== 'done' && item.status === 'pending'
                      && run.items.findIndex((other) => other.status === 'pending') === i;
                    return (
                      <View
                        key={item.itemId}
                        style={[styles.runItem, i > 0 && styles.entryBorder, working && styles.runItemWorking]}
                        testID={`run-item-${item.status}`}
                      >
                        <View style={styles.runIcon}>
                          {working ? (
                            <ActivityIndicator size="small" color="#D97706" />
                          ) : item.status === 'drafted' ? (
                            <Feather name="check" size={15} color={Colors.success} />
                          ) : item.status === 'failed' ? (
                            <Feather name="alert-circle" size={15} color="#D97706" />
                          ) : item.status === 'pending' ? (
                            <View style={styles.pendingDot} />
                          ) : (
                            <Feather name="minus" size={15} color={Colors.text3} />
                          )}
                        </View>
                        <View style={styles.flex}>
                          <Text style={styles.entryTitle} numberOfLines={1}>{item.mealName || item.title || item.url}</Text>
                          <Text style={ui.hint}>
                            {working
                              ? 'Reading this one…'
                              : item.status === 'drafted'
                                ? item.needALook
                                  ? `In your review queue · ${item.needALook} ${item.needALook === 1 ? 'field needs' : 'fields need'} a look`
                                  : 'In your review queue'
                                : item.status === 'pending'
                                  ? 'Waiting'
                                  : item.detail || (item.status === 'skipped' ? 'Already Imported' : 'We could not read this one')}
                          </Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              </View>
            </Card>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 12 },
  titleGap: { marginBottom: 8 },
  gap: { marginBottom: 10 },
  gapLg: { marginBottom: 16 },
  top: { marginTop: 12 },
  small: { marginTop: 8 },
  flex: { flex: 1, minWidth: 0 },
  options: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    overflow: 'hidden',
    backgroundColor: Colors.surfaceRaised,
  },
  option: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 12 },
  optionBorder: { borderTopWidth: 1, borderTopColor: Colors.border },
  optionLabel: { fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text1 },
  optionLabelOn: { fontFamily: 'Inter_600SemiBold', color: Colors.brand },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: Colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: Colors.brand },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.brand },
  noteStrong: { fontFamily: 'Inter_600SemiBold' },
  fieldTitle: { fontSize: 14, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
  },
  saveButton: { marginTop: 10, alignSelf: 'flex-start', paddingHorizontal: 20 },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 10 },
  count: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: Colors.text1, marginRight: 4 },
  countCap: { color: '#B45309' },
  capText: { fontSize: 12, fontFamily: 'Inter_400Regular', color: '#B45309', lineHeight: 17 },
  filterMenu: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    padding: 6,
    marginBottom: 10,
    backgroundColor: Colors.surfaceRaised,
  },
  filterRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 6, paddingVertical: 7 },
  list: { borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.input, overflow: 'hidden' },
  entry: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: Colors.surfaceRaised },
  entryBorder: { borderTopWidth: 1, borderTopColor: Colors.border },
  entrySettled: { backgroundColor: Colors.surface },
  entryTitle: { fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text1 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  more: { padding: 12, gap: 8, borderTopWidth: 1, borderTopColor: Colors.border },
  importButton: { marginTop: 14 },
  runHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  runItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: Colors.surfaceRaised },
  runItemWorking: { backgroundColor: '#FFFBEB' },
  runIcon: { width: 18, alignItems: 'center', paddingTop: 1 },
  pendingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.borderStrong, marginTop: 4 },
});
