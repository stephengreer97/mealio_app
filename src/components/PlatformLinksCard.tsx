import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { Colors } from '../constants/colors';
import { Creator } from '../types';
import { creators as creatorsApi } from '../lib/api';
import {
  checkPlatformLink,
  polledSource,
  PLATFORM_SOURCES,
  SOURCE_LABELS,
  SOURCE_PLACEHOLDERS,
  type PlatformSource,
} from '../constants/creatorSources';
import Card from './ui/Card';
import Button from './ui/Button';
import Input from './ui/Input';

// ─────────────────────────────────────────────────────────────────────────────
// PlatformLinksCard — the four places a creator publishes, editable (MEAL-94)
//
// The mobile half of the web portal's card of the same name. They are collected
// on the application form and copied onto the row at approval, and until this
// existed on mobile there was no way for an app-only creator to change them at
// all: someone who started a YouTube channel six months later could not tell us,
// which silently blocked connecting it, the append setting (MEAL-78), a source
// switch and back-catalog import. Their only route was asking an operator to
// edit the row by hand.
//
// Adding a link tells us a place exists and nothing more. Which source Mealio
// polls, and whether it polls at all, stay an operator decision (MEAL-81), so
// nothing on this card can turn importing on. Touching the link that *is* being
// polled — changing it or clearing it, one rule for both — can turn it off: the
// server pauses the import pending review and says so, and this card stops
// claiming otherwise the moment it hears that back.
//
// The editor is a modal rather than four boxes in the portal's list header. The
// portal's meals live in a `FlatList` and text inputs in a list header get sat
// on by the keyboard; every other form in this app is a modal over a
// `KeyboardAwareScrollView`, and the publish form on this very screen is one.
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  creator: Creator;
  /**
   * Re-reads the creator from the server after a save.
   *
   * The PATCH answers with what *happened*, not with the row, and the links are
   * normalised server-side — `chefsarah.com` is stored as `https://chefsarah.com/`.
   * The web card predicts that locally and rewrites its boxes with the
   * prediction; asking the server is one request more and cannot be wrong, and
   * it refreshes `primary_source` / `import_opt_in` in the same breath.
   */
  onSaved: () => void | Promise<void>;
}

type Values = Record<PlatformSource, string>;

function initialValues(creator: Creator): Values {
  return {
    website: creator.websiteUrl ?? '',
    youtube: creator.youtubeUrl ?? '',
    instagram: creator.instagramUrl ?? '',
    tiktok: creator.tiktokUrl ?? '',
  };
}

export default function PlatformLinksCard({ creator, onSaved }: Props) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Values>(() => initialValues(creator));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [notices, setNotices] = useState<string[]>([]);
  /**
   * Set from the save that paused the import, because `creator` is the portal's
   * copy of a row the server has just changed. Without it the sentence below
   * would go on saying "Mealio is importing your recipes" directly above a
   * notice saying we have stopped, until the refresh landed.
   */
  const [paused, setPaused] = useState(false);

  // The server's copy is the one on screen. Re-seeded whenever it changes, which
  // after a save is the normalised links coming back — so a creator who typed
  // `chefsarah.com` ends up looking at the link we will actually fetch.
  useEffect(() => {
    setValues(initialValues(creator));
    setPaused(false);
  }, [creator.websiteUrl, creator.youtubeUrl, creator.instagramUrl, creator.tiktokUrl]);

  const polled = paused ? null : polledSource(creator);

  function edit(source: PlatformSource, text: string) {
    setValues((prev) => ({ ...prev, [source]: text }));
    setSaved(false);
  }

  async function save() {
    setError('');
    setSaved(false);
    setNotices([]);

    // The same rules the route enforces, run here so a typo costs a keystroke
    // instead of a round trip. Never stricter than the route: see the note in
    // `constants/creatorSources.ts` about which direction of drift bites.
    for (const source of PLATFORM_SOURCES) {
      const result = checkPlatformLink(source, values[source]);
      if (!result.ok) {
        setError(`${SOURCE_LABELS[source]}: ${result.error}`);
        return;
      }
    }

    setSaving(true);
    try {
      // All four, always, as strings. An empty string is how a link is removed
      // and it is the only value that says so unambiguously — the route reads a
      // missing key as "leave this one alone".
      const payload: Record<string, string> = {};
      for (const source of PLATFORM_SOURCES) payload[source] = values[source].trim();

      const result = await creatorsApi.updateLinks(payload);

      setNotices(Array.isArray(result?.notices) ? result.notices : []);
      if (result?.importPaused === true) setPaused(true);
      setSaved(true);
      await onSaved();
    } catch (err: any) {
      // The route's own sentence. It is the one that explains why a particular
      // link was refused, and rewriting it here would lose that.
      setError(err?.message || 'Could not save those links.');
    } finally {
      setSaving(false);
    }
  }

  const polledNotice = polled
    ? `Mealio is importing your recipes from your ${SOURCE_LABELS[polled]}. Moved, renamed or finished with it? ` +
      "Change or clear it here and we'll pause the import — it's the one we publish from under your name, so it " +
      'gets a look before anything starts again.'
    : null;

  return (
    <>
      <Card style={styles.card}>
        <Text style={styles.eyebrow}>WHERE YOU PUBLISH</Text>
        <Text style={styles.title}>Your links</Text>
        <Text style={styles.blurb}>
          Add or change these any time. Started a channel since you applied? Add it here and Mealio can help fill in
          your meals from what you already post. Adding a link never starts anything on its own.
        </Text>

        <View style={styles.summaryList}>
          {PLATFORM_SOURCES.map((source) => {
            const value = values[source];
            return (
              <View key={source} style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>{SOURCE_LABELS[source]}</Text>
                <Text style={value ? styles.summaryValue : styles.summaryEmpty} numberOfLines={1}>
                  {value || 'Not added'}
                </Text>
              </View>
            );
          })}
        </View>

        {polledNotice && <Text style={styles.polled}>{polledNotice}</Text>}

        <Button label="Manage links" variant="secondary" size="sm" onPress={() => setOpen(true)} />
      </Card>

      <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.safe}>
          <KeyboardAwareScrollView
            contentContainerStyle={styles.modalScroll}
            keyboardShouldPersistTaps="handled"
            enableOnAndroid
            extraScrollHeight={24}
          >
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Your links</Text>
              <TouchableOpacity onPress={() => setOpen(false)} accessibilityRole="button">
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.blurb}>
              Add or change these any time. Adding a link never starts anything on its own — leave a box empty to
              remove that link.
            </Text>

            {PLATFORM_SOURCES.map((source) => (
              <Input
                key={source}
                label={SOURCE_LABELS[source]}
                placeholder={SOURCE_PLACEHOLDERS[source]}
                value={values[source]}
                onChangeText={(text) => edit(source, text)}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                keyboardType="url"
                editable={!saving}
              />
            ))}

            {/*
              Said before they try to edit it rather than only once the save has
              already happened: "this is where your recipes come from" is why
              changing or clearing that link pauses the import, and a creator who
              reads it first is never surprised by it.
            */}
            {polledNotice && <Text style={styles.polled}>{polledNotice}</Text>}

            {!!error && <Text style={styles.error}>{error}</Text>}

            {notices.map((notice) => (
              <Text key={notice} style={styles.notice}>
                {notice}
              </Text>
            ))}

            <View style={styles.actions}>
              <Button label={saving ? 'Saving…' : 'Save links'} onPress={save} loading={saving} disabled={saving} />
              {saved && <Text style={styles.savedFlag}>Saved</Text>}
            </View>
          </KeyboardAwareScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 12 },
  eyebrow: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text3,
    letterSpacing: 1,
    marginBottom: 2,
  },
  title: { fontSize: 16, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 6 },
  blurb: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text2, lineHeight: 19, marginBottom: 12 },
  summaryList: { marginBottom: 12 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  summaryLabel: { width: 84, fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.text3 },
  summaryValue: { flex: 1, fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text1 },
  summaryEmpty: { flex: 1, fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text3 },
  polled: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text2, lineHeight: 18, marginBottom: 12 },
  error: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.error, marginBottom: 10 },
  notice: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text2, lineHeight: 19, marginBottom: 10 },
  safe: { flex: 1, backgroundColor: Colors.surface },
  modalScroll: { padding: 20, paddingBottom: 48 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  modalTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', color: Colors.text1 },
  modalClose: { fontSize: 20, color: Colors.text3, padding: 4 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  savedFlag: { fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.success },
});
