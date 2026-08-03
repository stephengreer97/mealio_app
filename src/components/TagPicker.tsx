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
  const filtered = query ? tags.filter((t) => t.toLowerCase().includes(query)) : tags;

  // An edit can open on a meal published before the cap was enforced, so this
  // can be positive. Saying how many to drop is more use than saying "too many".
  const over = selected.length - max;
  const full = selected.length >= max;

  function toggle(tag: string) {
    if (selected.includes(tag)) {
      onChange(selected.filter((t) => t !== tag));
      return;
    }
    if (full) return;
    onChange([...selected, tag]);
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
          ? `That is ${selected.length} tags. A meal takes at most ${max} — deselect ${over}.`
          : `${selected.length} of ${max} chosen`}
      </Text>
      <ScrollView style={styles.scroll} nestedScrollEnabled showsVerticalScrollIndicator={false}>
        <View style={styles.row} testID="tag-picker">
          {filtered.map((tag) => {
            const isSelected = selected.includes(tag);
            return (
              <Tag
                key={tag}
                label={tag}
                selected={isSelected}
                disabled={!isSelected && full}
                onPress={() => toggle(tag)}
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
