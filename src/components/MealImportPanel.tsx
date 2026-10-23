import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Colors, Radius } from '../constants/colors';
import { PASTED_TEXT_MAX, PASTED_TEXT_MIN } from '../constants/recipeImport';
import { meals as mealsApi, type MealImportResult } from '../lib/api';
import Button from './ui/Button';

// "Import a recipe" at the top of New Meal: paste a link or the recipe text,
// and the form below fills in. Nothing is saved here; the user still picks a
// store and taps Create Meal.
//
// Same flow as the website's `components/MealImportPanel.tsx`, against the same
// `POST /api/meals/import`. One deliberate difference: the web form puts a note
// under each flagged field, and this form has no Serves box and a separate
// ingredient editor, so the panel says once which fields to check instead.

type Prompt =
  | { kind: 'creator-match'; meal: { id: string; name: string; creatorName: string | null } }
  | { kind: 'duplicate'; meal: { id: string; name: string } }
  | { kind: 'upgrade'; message: string }
  | { kind: 'error'; message: string; suggestPaste?: boolean };

interface Props {
  onImported: (result: MealImportResult) => void;
  /** Opens the in-app purchase for Full Access. */
  onUpgrade: () => void;
  /** Shows a creator's published version of this recipe. */
  onOpenCreatorMeal: (presetMealId: string) => void;
}

function withScheme(raw: string): string {
  const url = raw.trim();
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'that page';
  }
}

/** The fields worth a second look: anything the import wrote but could not confirm. */
export function fieldsToCheck(result: MealImportResult): string[] {
  const c = result.confidence ?? {};
  const unsure = (field: { level?: string } | undefined) => Boolean(field && field.level && field.level !== 'green');
  const out: string[] = [];
  if (result.draft.name && unsure(c.name)) out.push('the name');
  const rows: string[] = (result.draft.ingredients ?? [])
    .map((ing: any, i: number) => (unsure(c.ingredients?.[i]) ? String(ing.ingredientName ?? '') : ''))
    .filter(Boolean);
  if (rows.length > 0) out.push(rows.length <= 3 ? rows.join(', ') : `${rows.length} ingredients`);
  if (result.draft.recipe && unsure(c.recipe)) out.push('the instructions');
  return out;
}

export default function MealImportPanel({ onImported, onUpgrade, onOpenCreatorMeal }: Props) {
  const [mode, setMode] = useState<'link' | 'text'>('link');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // The sheet can close while a request is in flight. Its answer must not fill
  // a form that is gone, and only the newest request may write.
  const requestId = useRef(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const tooLong = text.length > PASTED_TEXT_MAX;
  const canImport = !busy && (mode === 'link' ? Boolean(url.trim()) : text.trim().length >= PASTED_TEXT_MIN && !tooLong);

  async function run(flags: { ignoreCreatorMatch?: boolean; ignoreDuplicate?: boolean } = {}) {
    if (busy) return;
    const id = ++requestId.current;
    setBusy(true);
    setPrompt(null);
    setDone(null);
    const link = withScheme(url);
    try {
      const result = await mealsApi.importRecipe(mode === 'link' ? { url: link } : { text: text.trim() }, mode === 'link' ? flags : {});
      if (!mounted.current || id !== requestId.current) return;
      onImported(result);
      const check = fieldsToCheck(result);
      setDone(
        `Filled in from ${mode === 'link' ? hostOf(result.url || link) : 'your text'}. ` +
          (check.length > 0 ? `Check ${check.join('; ')} before saving. ` : '') +
          'Pick a store and tap Create Meal.' +
          (result.freeImportsLeft === 0 ? ' That was your free import.' : ''),
      );
    } catch (err: any) {
      if (!mounted.current || id !== requestId.current) return;
      const body = err?.body ?? {};
      if (body.status === 'creator-match') setPrompt({ kind: 'creator-match', meal: body.meal });
      else if (body.status === 'duplicate') setPrompt({ kind: 'duplicate', meal: body.meal });
      else if (body.status === 'upgrade-required') setPrompt({ kind: 'upgrade', message: body.error });
      else if (body.status === 'rejected') setPrompt({ kind: 'error', message: body.detail, suggestPaste: body.suggestPaste });
      else setPrompt({ kind: 'error', message: err?.message || 'That import did not work. Try again in a moment.' });
    } finally {
      if (mounted.current && id === requestId.current) setBusy(false);
    }
  }

  const tab = (value: 'link' | 'text', label: string) => (
    <TouchableOpacity
      onPress={() => { setMode(value); setPrompt(null); setDone(null); }}
      style={[styles.tab, mode === value && styles.tabOn]}
      accessibilityRole="button"
      accessibilityState={{ selected: mode === value }}
      testID={`meal-import-tab-${value}`}
    >
      <Text style={[styles.tabText, mode === value && styles.tabTextOn]}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.card} testID="meal-import">
      <View style={styles.header}>
        <Text style={styles.title}>Import a recipe</Text>
        <View style={styles.tabs}>
          {tab('link', 'Paste a link')}
          {tab('text', 'Paste text')}
        </View>
      </View>

      {mode === 'link' ? (
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          placeholder="https://… a recipe page"
          placeholderTextColor={Colors.text3}
          keyboardType="url"
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Recipe link"
          testID="meal-import-url"
        />
      ) : (
        <>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={text}
            onChangeText={setText}
            placeholder="Paste the recipe: the ingredients and the method."
            placeholderTextColor={Colors.text3}
            multiline
            accessibilityLabel="Recipe text"
            testID="meal-import-text"
          />
          <Text style={[styles.hint, tooLong && styles.hintOver]} testID="meal-import-count">
            {text.length.toLocaleString('en-US')} / {PASTED_TEXT_MAX.toLocaleString('en-US')} characters
          </Text>
        </>
      )}

      <Button
        label={busy ? 'Reading the recipe… about 10 seconds' : 'Import'}
        variant="secondary"
        onPress={() => void run()}
        disabled={!canImport}
        loading={busy}
        testID="meal-import-go"
      />

      {done && <Text style={styles.done} testID="meal-import-done">{done}</Text>}

      {prompt?.kind === 'creator-match' && (
        <View style={styles.prompt} testID="meal-import-creator-match">
          <Text style={styles.body}>
            {prompt.meal.creatorName ? `This is ${prompt.meal.creatorName}’s recipe on Mealio.` : 'This recipe is on Mealio.'}{' '}
            Saving their version supports them.
          </Text>
          <View style={styles.row}>
            <Button
              label={prompt.meal.creatorName ? `See ${prompt.meal.creatorName}’s version` : 'See it on Mealio'}
              size="sm"
              onPress={() => onOpenCreatorMeal(prompt.meal.id)}
            />
            <Button label="Import my own copy" size="sm" variant="secondary" onPress={() => void run({ ignoreCreatorMatch: true })} />
          </View>
        </View>
      )}

      {prompt?.kind === 'duplicate' && (
        <View style={styles.prompt} testID="meal-import-duplicate">
          <Text style={styles.body}>You already have “{prompt.meal.name}” from this link.</Text>
          <Button label="Import it again" size="sm" variant="secondary" onPress={() => void run({ ignoreCreatorMatch: true, ignoreDuplicate: true })} />
        </View>
      )}

      {prompt?.kind === 'upgrade' && (
        <View style={styles.prompt} testID="meal-import-upgrade">
          <Text style={styles.body}>{prompt.message}</Text>
          <Button label="Get Full Access" size="sm" onPress={onUpgrade} />
        </View>
      )}

      {prompt?.kind === 'error' && (
        <View style={styles.prompt} testID="meal-import-error">
          <Text style={styles.error}>{prompt.message}</Text>
          {prompt.suggestPaste ? (
            <Button label="Paste the recipe text instead" size="sm" variant="secondary" onPress={() => { setMode('text'); setPrompt(null); }} />
          ) : (
            <Text style={styles.hint}>You can still fill the form in yourself.</Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.card,
    padding: 12,
    gap: 10,
    marginBottom: 16,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text2 },
  tabs: { flexDirection: 'row', backgroundColor: Colors.border, borderRadius: Radius.input, padding: 2 },
  tab: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: Radius.input - 2 },
  tabOn: { backgroundColor: Colors.surfaceRaised },
  tabText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: Colors.text3 },
  tabTextOn: { color: Colors.text1 },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
  },
  textArea: { minHeight: 110, textAlignVertical: 'top' },
  hint: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3 },
  hintOver: { color: Colors.brand },
  done: { fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.success },
  prompt: { gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  body: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text2 },
  error: { fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.brand },
});
