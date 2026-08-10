// A notice whose SUMMARY and a preview of its detail are always visible, and
// whose full detail expands on tap (MEAL-177).
//
// The done screen's banners each carry a count and then a comma-joined list of
// product names. Those lists are unbounded — a 30-item run can skip a dozen — and
// they were rendered with `numberOfLines`, which silently truncates: the user was
// told "12 items skipped during review" and then shown four of them with no way
// to see the rest. Truncation with no affordance is the worst of both, because it
// looks complete.
//
// THE FIX IS THE AFFORDANCE, NOT THE HIDING. The first cut collapsed the list
// away entirely and that was the wrong trade: three lines hold roughly ten
// comma-joined grocery names, so truncation only bit on runs that skipped a
// dozen items, while collapsing hid the names on every run — including the
// one-item case the user could simply read before. Bug surface 12+, regression
// surface 1-11. So the collapsed state keeps exactly what it always showed, and
// the trailing ellipsis (RN's own, only drawn when the text really does
// overflow) is what says there is more behind the tap.
//
// THE SUMMARY IS NEVER COLLAPSED either. That is why this takes `title` and
// `body` separately rather than one blob to elide: the verdict — how many, and
// that something needs attention — has to survive whatever the body does.
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
  /** The unbounded part — usually a joined list of names. Previewed collapsed,
   *  shown whole on tap. */
  body: string;
  testID?: string;
  /** So the caller keeps its existing banner frame. Typed, not `object`: an
   *  untyped style prop accepts a TextStyle on a View and says nothing. */
  containerStyle?: StyleProp<ViewStyle>;
  /** Tallest the expanded body gets before it scrolls. */
  maxBodyHeight?: number;
  /** Lines of body kept visible while collapsed. Defaults to the 3 the skipped
   *  banner already used, so collapsing costs the user nothing they had. */
  collapsedLines?: number;
}

export default function ExpandableNotice({
  title,
  body,
  testID,
  containerStyle,
  maxBodyHeight = 150,
  collapsedLines = 3,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  const toggle = (
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
  );

  // Collapsed, the ellipsized preview is INSIDE the target. It is the thing the
  // comments below call the signal that there is more, so a tap on it has to do
  // what it advertises — an affordance that ignores the finger is worse than no
  // affordance, because the user concludes there is nothing behind it.
  //
  // Expanded, the body is deliberately OUTSIDE: it is a ScrollView, and wrapping
  // a scroll surface in a Pressable makes the two compete for the same gesture.
  // The header remains the way back.
  if (!expanded) {
    return (
      <View style={containerStyle} testID={testID}>
        <Pressable
          onPress={() => setExpanded(true)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`${title}. Show details`}
          testID={testID ? `${testID}-toggle` : undefined}
        >
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Ionicons name="chevron-down" size={16} color={Colors.text3} />
          </View>
          {/* The preview, and the affordance. `ellipsizeMode="tail"` is explicit
              rather than left to the default because the trailing "…" is the
              whole signal that there is more here — it is the only thing
              distinguishing a list that ends from a list that was cut, and RN
              draws it only when the text genuinely overflows, so a short list
              makes no promise it cannot keep. The chevron says the same thing
              for the case where a screen reader never sees the glyph. */}
          <Text
            style={styles.body}
            numberOfLines={collapsedLines}
            ellipsizeMode="tail"
            testID={testID ? `${testID}-preview` : undefined}
          >
            {body}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={containerStyle} testID={testID}>
      {toggle}
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
