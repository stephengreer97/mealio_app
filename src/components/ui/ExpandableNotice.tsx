// A notice whose SUMMARY is always visible and whose detail expands on tap
// (MEAL-177).
//
// The done screen's banners each carry a count and then a comma-joined list of
// product names. Those lists are unbounded — a 30-item run can skip a dozen — and
// they were rendered with `numberOfLines`, which silently truncates: the user was
// told "12 items skipped during review" and then shown four of them with no way
// to see the rest. Truncation with no affordance is the worst of both, because it
// looks complete.
//
// THE SUMMARY IS NEVER COLLAPSED. That is the load-bearing rule, and it is why
// this takes `title` and `body` separately rather than one blob to elide. The
// verdict — how many, and that something needs attention — has to survive the
// collapsed state, or hiding the detail hides the problem. Only the list folds.
//
// When expanded the body scrolls inside its own bounded height rather than
// growing the sheet. The reason is stronger than "tidier": the done screen's
// banner column is NOT inside a ScrollView — it is a direct child of the
// SafeAreaView, and its siblings do not shrink — so an unbounded body has
// nowhere to overflow to and pushes the cart rows, and eventually the Done
// button, off the screen. An earlier version of this comment claimed the column
// already scrolled; it does not. MEAL-193 covers making that true.

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../constants/colors';

interface Props {
  /** Always visible, collapsed or not. The count and the verdict belong here. */
  title: string;
  /** Revealed on tap. The unbounded part — usually a joined list of names. */
  body: string;
  testID?: string;
  /** So the caller keeps its existing banner frame. Typed, not `object`: an
   *  untyped style prop accepts a TextStyle on a View and says nothing. */
  containerStyle?: StyleProp<ViewStyle>;
  /** Tallest the expanded body gets before it scrolls. */
  maxBodyHeight?: number;
}

export default function ExpandableNotice({
  title,
  body,
  testID,
  containerStyle,
  maxBodyHeight = 150,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={containerStyle} testID={testID}>
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        // The whole header is the target, not the chevron: a 13px glyph is below
        // any reasonable touch minimum, and the row is already the thing that
        // reads as tappable.
        style={styles.header}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        // The label says what the tap DOES. Without it a screen reader announces
        // only the count, which is exactly the information the collapsed state
        // already gives — so the control would be invisible to it.
        accessibilityLabel={`${title}. ${expanded ? 'Hide' : 'Show'} details`}
        testID={testID ? `${testID}-toggle` : undefined}
      >
        <Text style={styles.title}>{title}</Text>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={16}
          color={Colors.text3}
        />
      </Pressable>
      {expanded && (
        <ScrollView
          style={{ maxHeight: maxBodyHeight }}
          // No nestedScrollEnabled: an earlier version set it and justified it as
          // required on iOS, which is backwards — RN documents it as Android-only
          // and iOS nests by default. Nothing competes for the gesture anyway,
          // because the done screen's banner column is NOT inside a ScrollView
          // (it is a direct child of the SafeAreaView). That last fact is also why
          // the height cap below matters more than it looks: the column cannot
          // scroll, so an unbounded body has nowhere to overflow to. See MEAL-193.
          testID={testID ? `${testID}-body` : undefined}
        >
          <Text style={styles.body}>{body}</Text>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    // The row's own height is ~18pt (a 13px line beside a 16pt chevron), well
    // under the 44pt/48dp minimums. The container's padding sits OUTSIDE the
    // Pressable, so it does not count. This does.
    minHeight: 44,
  },
  title: {
    flex: 1,
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text2,
  },
  body: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: Colors.text3,
    lineHeight: 18,
    marginTop: 2,
  },
});
