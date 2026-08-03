import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Linking, BackHandler } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { Colors, Radius } from '../../constants/colors';
import { creatorDrafts, type CreatorDraft, type CreatorDraftBody, type DraftNotice } from '../../lib/api';
import { useCreatorDrafts } from '../../context/CreatorDraftsContext';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import IngredientEditor from '../../components/IngredientEditor';
import { Ingredient } from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
// CreatorReviewQueueScreen (MEAL-89)
//
// Where a creator decides what the poller extracted from their own posts:
// approve, edit, or decline, one recipe at a time.
//
// ## The queue is the feature, not the popup
//
// A single-draft modal is the easy case and the wrong thing to design for. A
// creator who has been away for a week can face ten pending drafts, so the
// screen is built for that size:
//
//   • Position is shown — "3 of 10" — so the end is visible. An unbounded stack
//     of cards is the thing people force-quit.
//   • Position survives backgrounding. The cursor is persisted as the draft's
//     *id*, not an index: decide two, background the app, and an index points at
//     a different recipe on the way back — which is worse than starting over,
//     because it looks right.
//   • Skipping is a first-class button. A creator who is not sure about this one
//     must be able to reach the next without deciding it; the alternative is
//     deciding in order to leave, and the decision made under that pressure is
//     Approve.
//
// ## Never blocking
//
// This is a view inside the Creator tab, not a Modal over the app. The tab bar
// stays on screen the whole time, so a creator who came to add a meal to their
// cart is one tap from Discover at every moment — including a creator who
// arrived here from a notification. Nothing traps anyone.
//
// ## Exceptions only
//
// A field that verified against the source is simply shown. Only flagged ones
// get a line underneath with the reason and the span we read. Silence is the
// signal, and the summary line is what tells a creator that silence means
// checked rather than skipped. All of that wording arrives from the server —
// see `creatorDrafts` in lib/api.ts for why none of it is derived here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the creator had got to, by draft id.
 *
 * Persisted rather than held in state because "backgrounded the app" and "the
 * OS killed it while it was backgrounded" are the same thing from here, and
 * losing the place on either is the same annoyance. SecureStore because it is
 * the storage this app already has; the value is not a secret.
 */
const CURSOR_KEY = 'mealio_draft_cursor';

/** One flagged field's line. Verified fields render nothing at all. */
function Notice({ notice }: { notice: DraftNotice | null | undefined }) {
  if (!notice) return null;
  return (
    <Text style={styles.notice} testID="import-notice">
      {notice.text}
      {notice.text && notice.evidence ? ' ' : ''}
      {notice.evidence ? (
        <>
          {notice.text ? 'We read: ' : 'we read: '}
          <Text style={styles.noticeQuote}>“{notice.evidence}”</Text>
        </>
      ) : null}
    </Text>
  );
}

function hostOf(url: string): string {
  const match = /^https?:\/\/(?:www\.)?([^/?#]+)/i.exec(url);
  return match ? match[1] : url;
}

function measurementOf(ing: { ingredientName: string; qty: number; unit: string; measure: string | null }): string {
  if (!ing.unit || ing.unit === 'qty') return (ing.qty ?? 1) > 1 ? `${ing.ingredientName}, ${ing.qty}` : ing.ingredientName;
  return ing.measure ? `${ing.ingredientName}, ${ing.measure} ${ing.unit}` : `${ing.ingredientName}, ${ing.unit}`;
}

export default function CreatorReviewQueueScreen({ onClose, draftId }: { onClose: () => void; draftId?: string }) {
  const { setWaiting } = useCreatorDrafts();
  const [drafts, setDrafts] = useState<CreatorDraft[] | null>(null);
  /**
   * The read failed, as distinct from the queue being empty.
   *
   * `catch { setDrafts([]) }` made one out of the other, and the empty state
   * then said "Nothing waiting — when we find a new recipe on your posts, it'll
   * show up here." Meanwhile `CreatorDraftsContext` deliberately does *not*
   * zero the badge on a failed read, which is right — so the tab said 3, the
   * portal card said 3, and tapping through said there was nothing. One screen,
   * two contradictory statements, and the reassuring one was wrong.
   */
  const [failed, setFailed] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<CreatorDraftBody | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  // A decision outlives a render. Without this a response landing after the
  // screen closes writes to dead state.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /**
   * Android's hardware Back leaves the queue, rather than the app.
   *
   * The queue is state inside the Creator tab and not a route of its own —
   * deliberately, so the tab bar stays on screen — which means React Navigation
   * has nothing to pop and Back fell through to the navigator: out of the tab,
   * or straight out of the app for a creator who arrived from a notification.
   * "Nothing traps anyone" has to include the button every Android user reaches
   * for first.
   */
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // Back out of the editor before backing out of the queue: a creator
      // mid-edit pressing Back means "stop editing", and losing the whole screen
      // would lose their corrections with it.
      if (editing) { setEditing(null); return true; }
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [editing, onClose]);

  const load = useCallback(async () => {
    try {
      const [{ drafts: list, waiting }, saved] = await Promise.all([
        creatorDrafts.list(),
        SecureStore.getItemAsync(CURSOR_KEY).catch(() => null),
      ]);
      if (!mountedRef.current) return;

      setDrafts(list);
      setFailed(false);
      // The server's count, not the length of this list: the list is capped at
      // 200 rows and the count is not, so badging from the list dropped a
      // creator's 250 to 200 the moment they opened the queue.
      setWaiting(typeof waiting === 'number' ? waiting : list.length);

      // Resume where they were, unless a notification named a specific recipe —
      // the tap was about that one, and landing on whatever the persisted
      // cursor happens to point at is the version of this that wastes it. A
      // cursor naming a draft that is no longer pending — decided here, decided
      // in a browser, taken back by an operator — falls back to the front
      // rather than to an index that would now be a different recipe.
      const asked = draftId && list.some((d) => d.id === draftId) ? draftId : null;
      const resumed = asked ?? (saved && list.some((d) => d.id === saved) ? saved : (list[0]?.id ?? null));
      setCursor(resumed);
      void rememberCursor(resumed);
    } catch {
      // Not an empty queue. The badge is left alone — `setWaiting` is not
      // called — and the screen below says we could not look rather than that
      // there is nothing to look at.
      if (mountedRef.current) { setDrafts([]); setFailed(true); }
    }
  }, [setWaiting, draftId]);

  useEffect(() => { void load(); }, [load]);

  async function rememberCursor(id: string | null) {
    try {
      if (id) await SecureStore.setItemAsync(CURSOR_KEY, id);
      else await SecureStore.deleteItemAsync(CURSOR_KEY);
    } catch {
      // A lost cursor costs a scroll, never a decision.
    }
  }

  const index = drafts && cursor ? drafts.findIndex((d) => d.id === cursor) : -1;
  const current = index >= 0 ? drafts![index] : null;

  function goTo(id: string | null) {
    setEditing(null);
    setCursor(id);
    void rememberCursor(id);
  }

  /**
   * Decides the draft on screen and advances.
   *
   * The row is dropped from local state rather than the whole queue refetched,
   * so "3 of 10" does not become "3 of 9" under a creator's finger and make the
   * end of the queue look like it moved. The badge takes the server's own
   * count, which answers a different question — how many are left overall — and
   * is allowed to differ from the length of this sitting's list.
   */
  async function decide(action: 'approve' | 'cancel', id: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await creatorDrafts.decide(action, [id]);
      if (!mountedRef.current) return;

      if (result.errors?.length) {
        // Usually "already decided", which is a second tap landing rather than a
        // failure — the conditional write server-side did its job and exactly
        // one publish happened. Say so plainly and move on.
        setMessage({ kind: 'bad', text: result.errors.join(' ') });
      } else if (action === 'approve' && result.published?.[0]) {
        setMessage({ kind: 'ok', text: `“${result.published[0].name}” is live.` });
      } else if (action === 'cancel') {
        setMessage({ kind: 'ok', text: 'Declined. We won’t offer that one again.' });
      }

      if (typeof result.waiting === 'number') setWaiting(result.waiting);

      const remaining = (drafts ?? []).filter((d) => d.id !== id);
      const next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)] ?? null;
      setDrafts(remaining);
      goTo(next?.id ?? null);
    } catch (err: any) {
      // Shown inline rather than as an Alert. An Alert is a modal, and a failed
      // decision is not a reason to put one in front of someone who may have
      // opened the app to do something else entirely.
      if (mountedRef.current) {
        setMessage({ kind: 'bad', text: err?.message || 'That didn’t go through. Nothing has been published.' });
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  /**
   * Saves a correction without deciding the draft.
   *
   * Editing is a fix, not an approval: the draft stays in the queue and the
   * creator still has to approve it afterwards, because someone correcting a
   * measure has not thereby said the recipe is right. The server drops our
   * confidence on every field they rewrote, so the card stops vouching for a
   * value we never checked — which is why the row is swapped for the server's
   * response rather than for the local form.
   */
  async function saveEdit(id: string, next: CreatorDraftBody) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const { draft: saved } = await creatorDrafts.edit(id, next);
      if (!mountedRef.current) return;
      setDrafts((prev) => (prev ?? []).map((d) => (d.id === id ? { ...d, ...saved } : d)));
      setEditing(null);
      setMessage({ kind: 'ok', text: 'Saved. It’s still waiting on you — editing doesn’t publish it.' });
    } catch (err: any) {
      if (mountedRef.current) setMessage({ kind: 'bad', text: err?.message || 'Those edits couldn’t be saved.' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  if (drafts === null) {
    return (
      <View style={styles.centre} testID="creator-queue-loading">
        <ActivityIndicator color={Colors.brand} />
      </View>
    );
  }

  // We could not look. Said plainly, because the badge that sent them here is
  // still showing whatever it last heard: "3 recipes are ready for you" on the
  // card behind, and "Nothing waiting" here, is a contradiction a creator has
  // to resolve on their own — and the reassuring half is the wrong one.
  if (failed) {
    return (
      <View style={styles.centre} testID="creator-queue-unreadable">
        <Feather name="wifi-off" size={28} color={Colors.text3} />
        <Text style={styles.emptyTitle}>We couldn’t load your queue</Text>
        <Text style={styles.emptyBody}>
          Something went wrong on the way, so we don’t know what’s waiting for you right now. Nothing has been
          decided and nothing has been published.
        </Text>
        <Button label="Try again" size="sm" onPress={() => void load()} style={{ marginTop: 16 }} />
        <Button label="Back to your portal" variant="secondary" size="sm" onPress={onClose} style={{ marginTop: 8 }} />
      </View>
    );
  }

  // Emptied — either it always was, or they just finished it. The last
  // decision's message stays on screen: without it, approving the last draft
  // would swap the card out mid-tap and "your recipe is live" would never be
  // read, at exactly the moment a creator is most likely to tap Approve again.
  if (!current) {
    return (
      <View style={styles.centre} testID="creator-queue-empty">
        <Feather name="check-circle" size={28} color={Colors.success} />
        <Text style={styles.emptyTitle}>{message ? 'That’s everything' : 'Nothing waiting'}</Text>
        <Text style={styles.emptyBody}>
          {message?.text ?? 'When we find a new recipe on your posts, it’ll show up here for you to approve.'}
        </Text>
        <Button label="Back to your portal" variant="secondary" size="sm" onPress={onClose} style={{ marginTop: 16 }} />
      </View>
    );
  }

  const notices = current.review.notices;
  const body = current.draft;

  return (
    <View style={styles.root} testID="creator-review-queue">
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose} style={styles.headerBack} accessibilityLabel="Back to your portal">
          <Feather name="chevron-left" size={22} color={Colors.text2} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Ready for you</Text>
          <Text style={styles.headerSub}>From {hostOf(current.sourceUrl)}</Text>
        </View>
        {/* Position, so the end is visible. */}
        <Text style={styles.position} testID="queue-position">
          {index + 1} of {drafts.length}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {message && (
          <View style={[styles.message, message.kind === 'ok' ? styles.messageOk : styles.messageBad]}>
            <Text style={message.kind === 'ok' ? styles.messageOkText : styles.messageBadText}>{message.text}</Text>
          </View>
        )}

        {editing ? (
          /*
            The fields most likely to be wrong on an extraction, pre-filled.
            So a wrong measure is a fix rather than a decline-and-redo.

            The same shape and the same constraints POST /api/creator/meals
            publishes, because approving feeds this straight into the publisher
            — a draft that would be refused at publish time is better refused
            while the creator is still looking at it, which is what the server's
            validation does with the 400 shown above.
          */
          <View testID="draft-editor">
            <Input
              label="Meal name"
              value={editing.name}
              onChangeText={(name) => setEditing({ ...editing, name })}
            />
            <Input
              label="Serves"
              placeholder="4 or 2-4"
              value={editing.serves ?? ''}
              onChangeText={(serves) => setEditing({ ...editing, serves })}
            />
            <Text style={styles.editorLabel}>Ingredients</Text>
            <IngredientEditor
              ingredients={editing.ingredients as Ingredient[]}
              onChange={(ingredients) => setEditing({ ...editing, ingredients: ingredients as CreatorDraftBody['ingredients'] })}
            />
            <Input
              label="Method"
              value={editing.recipe ?? ''}
              onChangeText={(recipe) => setEditing({ ...editing, recipe })}
              multiline
              numberOfLines={8}
              style={styles.multiline}
            />
            <Input
              label="Story"
              value={editing.story ?? ''}
              onChangeText={(story) => setEditing({ ...editing, story })}
              multiline
              numberOfLines={3}
              style={styles.multiline}
            />
            <Button label="Save edits" onPress={() => saveEdit(current.id, editing)} disabled={busy} />
            <Button label="Cancel" variant="ghost" size="sm" onPress={() => setEditing(null)} disabled={busy} style={{ marginTop: 8 }} />
            <Text style={styles.footnote}>
              Saving doesn’t publish it. It stays here, and every field you change drops our check of it — we can’t
              vouch for a value we didn’t read.
            </Text>
          </View>
        ) : (
        <>
        <View style={styles.card} testID="draft-card">
          {body.photoUrl ? (
            <Image source={{ uri: body.photoUrl }} style={styles.photo} contentFit="cover" />
          ) : null}
          <Notice notice={notices.photoUrl} />

          <Text style={styles.mealName}>{body.name}</Text>
          <Notice notice={notices.name} />

          <View style={styles.metaRow}>
            {body.serves ? <Text style={styles.meta}>Serves {body.serves}</Text> : null}
            {body.difficulty ? <Text style={styles.meta}>Difficulty {body.difficulty}/5</Text> : null}
          </View>
          <Notice notice={notices.serves} />
          <Notice notice={notices.difficulty} />

          {body.tags?.length ? (
            <View style={styles.tagRow}>
              {body.tags.map((tag) => (
                <View key={tag} style={styles.tag}><Text style={styles.tagText}>{tag}</Text></View>
              ))}
            </View>
          ) : null}
          <Notice notice={notices.tags} />

          {body.story ? <Text style={styles.story}>{body.story}</Text> : null}
          <Notice notice={notices.story} />

          <Text style={styles.sectionTitle}>Ingredients</Text>
          {body.ingredients.map((ing, i) => (
            <View key={i} style={styles.ingredientRow}>
              <Text style={styles.ingredient}>{measurementOf(ing)}</Text>
              {/* Index-aligned with the rows on screen, so a callout can never
                  end up under the wrong ingredient. */}
              <Notice notice={notices.ingredients?.[i]} />
            </View>
          ))}

          {body.recipe ? (
            <>
              <Text style={styles.sectionTitle}>Method</Text>
              <Text style={styles.recipe}>{body.recipe}</Text>
            </>
          ) : null}
          <Notice notice={notices.recipe} />
        </View>

        {/* Counts, never a score — a "92% confident" badge is the anti-pattern
            the per-field checks exist to avoid. */}
        <Text style={styles.summary} testID="draft-summary">
          {current.review.summaryText}{' '}
          {current.summary.needALook === 0
            ? 'Everything we filled in matched the page we read.'
            : 'The notes above say what we read and why we couldn’t confirm it.'}
        </Text>

        {/* Approve / decline, and nothing that decides more than one recipe.
            There is no "approve all" here on purpose, and the server refuses a
            batched approve as well. */}
        <Button
          label="Approve & publish"
          onPress={() => decide('approve', current.id)}
          disabled={busy}
          style={{ marginTop: 14 }}
        />
        <Button
          label="Edit first"
          variant="secondary"
          onPress={() => setEditing({ ...body })}
          disabled={busy}
          style={{ marginTop: 8 }}
        />
        <Button
          label="Not this one"
          variant="danger"
          onPress={() => decide('cancel', current.id)}
          disabled={busy}
          style={{ marginTop: 8 }}
        />
        <Button
          label="Open my post"
          variant="ghost"
          size="sm"
          onPress={() => Linking.openURL(current.sourceUrl).catch(() => {})}
          style={{ marginTop: 8 }}
        />

        {/*
          Skipping decides nothing, and it is deliberately as reachable as the
          other two. A creator who is unsure has to be able to move on without
          publishing or declining.
        */}
        {drafts.length > 1 && (
          <View style={styles.skipRow}>
            <TouchableOpacity
              onPress={() => goTo(drafts[(index - 1 + drafts.length) % drafts.length].id)}
              disabled={busy}
              testID="previous-draft"
            >
              <Text style={styles.skipText}>← Previous</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => goTo(drafts[(index + 1) % drafts.length].id)}
              disabled={busy}
              testID="skip-draft"
            >
              <Text style={styles.skipText}>Skip for now →</Text>
            </TouchableOpacity>
          </View>
        )}

        <Text style={styles.footnote} testID="queue-actions-note">
          Approving publishes it to Discover under your name. “Not this one” declines it — we won’t offer that recipe
          again, and it won’t come back the next time we check your posts. Skipping decides nothing.
        </Text>
        </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: Colors.bg },
  emptyTitle: { fontFamily: 'Inter_700Bold', fontSize: 16, color: Colors.text1, marginTop: 12 },
  emptyBody: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.text2, textAlign: 'center', marginTop: 6, lineHeight: 19 },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 12,
    backgroundColor: Colors.surfaceRaised, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  headerBack: { padding: 4 },
  headerTitle: { fontFamily: 'Inter_700Bold', fontSize: 15, color: Colors.text1 },
  headerSub: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.text3, marginTop: 1 },
  position: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: Colors.text2 },

  scroll: { padding: 16, paddingBottom: 40 },

  message: { borderRadius: Radius.input, padding: 10, marginBottom: 12 },
  messageOk: { backgroundColor: '#E9F7EF' },
  messageBad: { backgroundColor: Colors.brandLight },
  messageOkText: { fontFamily: 'Inter_500Medium', fontSize: 12, color: Colors.success },
  messageBadText: { fontFamily: 'Inter_500Medium', fontSize: 12, color: Colors.brand },

  card: {
    backgroundColor: Colors.surfaceRaised, borderRadius: Radius.card,
    borderWidth: 1, borderColor: Colors.border, padding: 16,
  },
  photo: { width: '100%', height: 170, borderRadius: Radius.input, marginBottom: 12 },
  mealName: { fontFamily: 'Inter_700Bold', fontSize: 18, color: Colors.text1 },
  metaRow: { flexDirection: 'row', gap: 12, marginTop: 6 },
  meta: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.text2 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  tag: { backgroundColor: Colors.surface, borderRadius: 99, paddingHorizontal: 9, paddingVertical: 3 },
  tagText: { fontFamily: 'Inter_500Medium', fontSize: 11, color: Colors.text2 },
  story: { fontFamily: 'Inter_400Regular_Italic', fontSize: 13, color: Colors.text2, marginTop: 12, lineHeight: 19 },
  sectionTitle: { fontFamily: 'Inter_700Bold', fontSize: 13, color: Colors.text1, marginTop: 16, marginBottom: 6 },
  ingredientRow: { marginBottom: 4 },
  ingredient: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.text1 },
  recipe: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.text1, lineHeight: 20 },

  // No colour token. The sentence and the quote carry the meaning, which is
  // also what makes a flagged field read the same to someone who cannot
  // separate amber from red.
  notice: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.text2, marginTop: 3, lineHeight: 16 },
  noticeQuote: { color: Colors.text1 },

  summary: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.text2, marginTop: 12, lineHeight: 18 },

  skipRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 },
  skipText: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.text2 },

  footnote: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.text3, marginTop: 16, lineHeight: 16 },

  editorLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.text1, marginBottom: 6 },
  multiline: { minHeight: 90, textAlignVertical: 'top' },
});
