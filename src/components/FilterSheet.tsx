import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ScrollView,
  TextInput,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius } from '../constants/colors';
import { ALL_TAGS } from '../constants/tags';
import Button from './ui/Button';
import Tag from './ui/Tag';

export interface FilterValues {
  tags: string[];
  difficulty: number[];
  sort: string;
  authors: string[];
  ingredients: string[];
  excludeIngredients: string[];
}

export const EMPTY_FILTERS: FilterValues = {
  tags: [],
  difficulty: [],
  sort: 'trending',
  authors: [],
  ingredients: [],
  excludeIngredients: [],
};

interface FilterSheetProps {
  visible: boolean;
  initial: FilterValues;
  authorSuggestions?: string[];
  onClose: () => void;
  onApply: (filters: FilterValues) => void;
}

export default function FilterSheet({ visible, initial, authorSuggestions = [], onClose, onApply }: FilterSheetProps) {
  const [tags, setTags] = useState<string[]>(initial.tags);
  const [tagSearch, setTagSearch] = useState('');
  const [difficulty, setDifficulty] = useState<number[]>(initial.difficulty);
  const [sort, setSort] = useState(initial.sort);
  const [authors, setAuthors] = useState<string[]>(initial.authors);
  const [authorInput, setAuthorInput] = useState('');
  const [showAuthorSug, setShowAuthorSug] = useState(false);
  const [ingredients, setIngredients] = useState<string[]>(initial.ingredients);
  const [ingInput, setIngInput] = useState('');
  const [excludeIngredients, setExcludeIngredients] = useState<string[]>(initial.excludeIngredients);
  const [excludeInput, setExcludeInput] = useState('');

  function toggleTag(tag: string) {
    setTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  }

  function toggleDifficulty(d: number) {
    setDifficulty((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
    );
  }

  function addAuthor() {
    const val = authorInput.trim();
    if (val && !authors.includes(val)) setAuthors((prev) => [...prev, val]);
    setAuthorInput('');
    setShowAuthorSug(false);
  }

  function addIngredient() {
    const val = ingInput.trim().toLowerCase();
    if (val && !ingredients.includes(val)) setIngredients((prev) => [...prev, val]);
    setIngInput('');
  }

  function addExclude() {
    const val = excludeInput.trim().toLowerCase();
    if (val && !excludeIngredients.includes(val)) setExcludeIngredients((prev) => [...prev, val]);
    setExcludeInput('');
  }

  function handleApply() {
    onApply({ tags, difficulty, sort, authors, ingredients, excludeIngredients });
    onClose();
  }

  function handleReset() {
    setTags([]);
    setDifficulty([]);
    setSort('trending');
    setAuthors([]);
    setAuthorInput('');
    setIngredients([]);
    setIngInput('');
    setExcludeIngredients([]);
    setExcludeInput('');
    setTagSearch('');
  }

  const filteredTags = tagSearch.trim()
    ? ALL_TAGS.filter((t) => t.toLowerCase().includes(tagSearch.toLowerCase()))
    : ALL_TAGS;

  const authorSuggFiltered = authorSuggestions.filter(
    (a) => authorInput.trim() && a.toLowerCase().includes(authorInput.toLowerCase()) && !authors.includes(a)
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Text style={styles.title}>Filter & Sort</Text>
          <TouchableOpacity onPress={onClose}>
            <Text style={styles.close}>✕</Text>
          </TouchableOpacity>
        </View>

        <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" enableOnAndroid extraScrollHeight={24}>

          {/* Sort */}
          <Text style={styles.sectionLabel}>Sort by</Text>
          <View style={styles.sortRow}>
            {(['trending', 'newest', 'following'] as const).map((s) => (
              <TouchableOpacity
                key={s}
                style={[styles.sortBtn, sort === s && styles.sortBtnActive]}
                onPress={() => setSort(s)}
              >
                <Text style={[styles.sortText, sort === s && styles.sortTextActive]}>
                  {s === 'trending' ? 'Trending' : s === 'newest' ? 'New' : 'Following'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Author */}
          <Text style={styles.sectionLabel}>Author</Text>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.textInput}
              placeholder="Type author name…"
              placeholderTextColor={Colors.text3}
              value={authorInput}
              onChangeText={(v) => { setAuthorInput(v); setShowAuthorSug(true); }}
              onSubmitEditing={addAuthor}
              returnKeyType="done"
            />
            <TouchableOpacity
              style={[styles.addBtn, !authorInput.trim() && styles.addBtnDisabled]}
              onPress={addAuthor}
              disabled={!authorInput.trim()}
            >
              <Text style={styles.addBtnText}>+ Add</Text>
            </TouchableOpacity>
          </View>
          {showAuthorSug && authorSuggFiltered.length > 0 && (
            <View style={styles.suggestions}>
              {authorSuggFiltered.slice(0, 5).map((a) => (
                <TouchableOpacity
                  key={a}
                  style={styles.suggestion}
                  onPress={() => { setAuthors((prev) => [...prev, a]); setAuthorInput(''); setShowAuthorSug(false); }}
                >
                  <Text style={styles.suggestionText}>{a}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {authors.length > 0 && (
            <View style={styles.chipRow}>
              {authors.map((a) => (
                <View key={a} style={styles.chip}>
                  <Text style={styles.chipText}>{a}</Text>
                  <TouchableOpacity onPress={() => setAuthors((prev) => prev.filter((x) => x !== a))}>
                    <Text style={styles.chipX}>×</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          {/* Difficulty */}
          <Text style={styles.sectionLabel}>Difficulty</Text>
          <View style={styles.diffRow}>
            {[1, 2, 3, 4, 5].map((d) => {
              const selected = difficulty.includes(d);
              return (
                <TouchableOpacity
                  key={d}
                  style={[styles.diffBtn, selected && styles.diffBtnActive]}
                  onPress={() => toggleDifficulty(d)}
                >
                  <View style={styles.diffDots}>
                    {[1, 2, 3, 4, 5].map((i) => (
                      <View
                        key={i}
                        style={[styles.dot, i <= d ? styles.dotFilled : styles.dotEmpty]}
                      />
                    ))}
                  </View>
                  <Text style={[styles.diffLabel, selected && styles.diffLabelActive]}>{d}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Tags */}
          <Text style={styles.sectionLabel}>Tags</Text>
          <TextInput
            style={[styles.textInput, { marginBottom: 8 }]}
            placeholder="Search tags…"
            placeholderTextColor={Colors.text3}
            value={tagSearch}
            onChangeText={setTagSearch}
          />
          <ScrollView
            style={styles.tagScroll}
            nestedScrollEnabled
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.tagRow}>
              {filteredTags.map((tag) => (
                <Tag
                  key={tag}
                  label={tag}
                  selected={tags.includes(tag)}
                  onPress={() => toggleTag(tag)}
                />
              ))}
            </View>
          </ScrollView>

          {/* Contains Ingredients */}
          <Text style={styles.sectionLabel}>Contains Ingredients</Text>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.textInput}
              placeholder="e.g. chicken, garlic…"
              placeholderTextColor={Colors.text3}
              value={ingInput}
              onChangeText={setIngInput}
              onSubmitEditing={addIngredient}
              returnKeyType="done"
            />
            <TouchableOpacity
              style={[styles.addBtn, !ingInput.trim() && styles.addBtnDisabled]}
              onPress={addIngredient}
              disabled={!ingInput.trim()}
            >
              <Text style={styles.addBtnText}>+ Add</Text>
            </TouchableOpacity>
          </View>
          {ingredients.length > 0 && (
            <View style={styles.chipRow}>
              {ingredients.map((ing) => (
                <View key={ing} style={styles.chip}>
                  <Text style={styles.chipText}>{ing}</Text>
                  <TouchableOpacity onPress={() => setIngredients((prev) => prev.filter((x) => x !== ing))}>
                    <Text style={styles.chipX}>×</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          {/* Exclude Ingredients */}
          <Text style={styles.sectionLabel}>Exclude Ingredients</Text>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.textInput}
              placeholder="e.g. nuts, dairy…"
              placeholderTextColor={Colors.text3}
              value={excludeInput}
              onChangeText={setExcludeInput}
              onSubmitEditing={addExclude}
              returnKeyType="done"
            />
            <TouchableOpacity
              style={[styles.addBtn, !excludeInput.trim() && styles.addBtnDisabled]}
              onPress={addExclude}
              disabled={!excludeInput.trim()}
            >
              <Text style={styles.addBtnText}>+ Add</Text>
            </TouchableOpacity>
          </View>
          {excludeIngredients.length > 0 && (
            <View style={styles.chipRow}>
              {excludeIngredients.map((ex) => (
                <View key={ex} style={[styles.chip, styles.chipExclude]}>
                  <Text style={styles.chipText}>{ex}</Text>
                  <TouchableOpacity onPress={() => setExcludeIngredients((prev) => prev.filter((x) => x !== ex))}>
                    <Text style={styles.chipX}>×</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

        </KeyboardAwareScrollView>

        <View style={styles.footer}>
          <Button label="Reset" variant="secondary" onPress={handleReset} style={{ flex: 1, marginRight: 8 }} />
          <Button label="Apply Filters" onPress={handleApply} style={{ flex: 2 }} />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  title: { fontSize: 20, fontFamily: 'Inter_700Bold', color: Colors.text1 },
  close: { fontSize: 20, color: Colors.text3 },
  scroll: { padding: 20, paddingBottom: 8 },
  sectionLabel: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text2,
    marginBottom: 10,
    marginTop: 16,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sortRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  sortBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    backgroundColor: Colors.surfaceRaised,
  },
  sortBtnActive: { borderColor: Colors.brand, backgroundColor: Colors.brandLight },
  sortText: { fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text2 },
  sortTextActive: { color: Colors.brand },
  inputRow: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  textInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
    letterSpacing: 0,
  },
  addBtn: {
    backgroundColor: Colors.brand,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
    paddingVertical: 8,
    justifyContent: 'center',
  },
  addBtnDisabled: { backgroundColor: Colors.border },
  addBtnText: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: '#fff' },
  suggestions: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised,
    marginBottom: 6,
    overflow: 'hidden',
  },
  suggestion: { paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.border },
  suggestionText: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text1 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.brandLight,
    borderRadius: 20,
    paddingVertical: 4,
    paddingLeft: 10,
    paddingRight: 6,
    gap: 4,
  },
  chipExclude: { backgroundColor: '#FEF2F2' },
  chipText: { fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.brand },
  chipX: { fontSize: 16, color: Colors.brand, lineHeight: 18 },
  diffRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  diffBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceRaised,
    gap: 4,
  },
  diffBtnActive: { borderColor: Colors.brand, backgroundColor: Colors.brandLight },
  diffDots: { flexDirection: 'row', gap: 2 },
  dot: { width: 5, height: 5, borderRadius: 3 },
  dotFilled: { backgroundColor: Colors.brand },
  dotEmpty: { backgroundColor: Colors.border },
  diffLabel: { fontSize: 12, fontFamily: 'Inter_500Medium', color: Colors.text3 },
  diffLabelActive: { color: Colors.brand },
  tagScroll: {
    maxHeight: 160,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 4,
  },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap' },
  footer: {
    flexDirection: 'row',
    padding: 20,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
});
