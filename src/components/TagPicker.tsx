import React from 'react';
import { View, Text, TextInput, ScrollView, StyleSheet } from 'react-native';
import Tag from './ui/Tag';
import { Colors, Radius } from '../constants/colors';
import { ALL_TAGS, MAX_MEAL_TAGS } from '../constants/tags';

/**
 * The publish form's tag picker.
 *
 * Lifted out of `CreatorPortalScreen` when it grew the cap the web form has
 * always had. The screen had no limit at all: a creator could select nine tags,
 * and `POST /api/creator/meals` — which now refuses an over-cap list rather than
 * keeping the first three — would turn Save Meal into an error message about a
 * rule the form never mentioned.
 *
 * The behaviour mirrors the web picker (`app/creator/page.tsx`) deliberately:
 *
 *   - a tag beyond the cap is **faded and inert**, not removed. Removing them
 *     would reflow the list under the thumb mid-tap and hide which tags exist.
 *   - deselecting makes room again — the cap is a cap, not a freeze.
 *   - the count is on screen, so "why won't this one take?" is answered before
 *     it is asked.
 *
 * Search is a prop rather than internal state because the form lives inside a
 * `Modal` that stays mounted between openings; the screen clears it when the
 * form opens on a different meal, and internal state would carry the last
 * creator's search into the next meal.
 */

export interface TagPickerProps {
  selected: string[];
  onChange: (tags: string[]) => void;
  search: string;
  onSearchChange: (text: string) => void;
  /** Overridable for tests; the product answer is `MAX_MEAL_TAGS`. */
  max?: number;
  tags?: string[];
}

export default function TagPicker({
  selected,
  onChange,
  search,
  onSearchChange,
  max = MAX_MEAL_TAGS,
  tags = ALL_TAGS,
}: TagPickerProps) {
  const query = search.trim().toLowerCase();
  // A chosen tag that no vocabulary lists still needs a chip, or it cannot be
  // deselected — it is selected, invisible, and posted back on every save, which
  // makes "deselect 2" an instruction with nothing to follow. Personal meals
  // really do carry these: the web `my-meals` picker takes a custom tag.
  const custom = selected.filter((t) => !tags.includes(t));
  const pool = [...custom, ...tags];
  const matching = query ? pool.filter((t) => t.toLowerCase().includes(query)) : pool;
  // Chosen tags first, as every other picker in the product does. Otherwise the
  // three that are actually on the meal are scattered through eighty-odd chips,
  // and the way back under the cap is to find them.
  const filtered = [
    ...matching.filter((t) => selected.includes(t)),
    ...matching.filter((t) => !selected.includes(t)),
  ];

  // An edit can open on a meal published before the cap was enforced, so this
  // can be positive. Saying how many to drop is more use than saying "too many".
  const over = selected.length - max;

  /**
   * The selection a press on `tag` would produce — and the *same* selection back
   * when the press would do nothing.
   *
   * Asked once and used for both the press and the disabled state, so the cap is
   * written in one place rather than copied into a `disabled` expression beside
   * it. It used to be two: a `disabled` prop that stopped the press, and an
   * `if (full) return` inside the handler. Only the first was reachable from a
   * test — RNTL will not dispatch a press onto a disabled `TouchableOpacity` —
   * so deleting the second left all 42 component tests green.
   */
  function nextFor(tag: string): string[] {
    if (selected.includes(tag)) return selected.filter((t) => t !== tag);
    if (selected.length >= max) return selected;
    return [...selected, tag];
  }

  return (
    <View>
      <TextInput
        style={styles.search}
        placeholder="Search tags…"
        placeholderTextColor={Colors.text3}
        value={search}
        onChangeText={onSearchChange}
        accessibilityLabel="Search tags"
      />
      <Text
        style={[styles.count, over > 0 && styles.countOver]}
        testID="tag-picker-count"
      >
        {over > 0
          ? `That is ${selected.length} tags. A meal takes at most ${max}. Deselect ${over}.`
          : `${selected.length} of ${max} chosen`}
      </Text>
      <ScrollView style={styles.scroll} nestedScrollEnabled showsVerticalScrollIndicator={false}>
        <View style={styles.row} testID="tag-picker">
          {filtered.map((tag) => {
            const next = nextFor(tag);
            // A chip whose press hands back the selection it already has is a
            // chip with nothing to do, which is exactly what `disabled` means.
            return (
              <Tag
                key={tag}
                label={tag}
                selected={selected.includes(tag)}
                disabled={next === selected}
                onPress={() => onChange(next)}
              />
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  search: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
    marginBottom: 8,
    letterSpacing: 0,
  },
  count: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: Colors.text3,
    marginBottom: 6,
  },
  countOver: {
    color: Colors.error,
  },
  scroll: {
    maxHeight: 180,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 8,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap' },
});
