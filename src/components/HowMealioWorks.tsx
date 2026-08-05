import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors, Radius } from '../constants/colors';
import {
  PITCH_HEADLINE,
  PITCH_SUBHEAD,
  PITCH_STEPS,
  PITCH_NOTHING_ORDERED,
  PITCH_FREE_TIER,
} from '../constants/pitch';

// The pitch, rendered. Every string comes from constants/pitch.ts — the copy of
// the web's canonical module — so this component chooses layout and nothing
// else. Do not inline or reword a string here; change it in the web original
// and copy it across (see the header of constants/pitch.ts).
//
// Used by WelcomeSheet (first run) and by Help → How Mealio works (the way back
// to it afterwards).

interface Props {
  /** Hidden when the surface has already said it in its own header. */
  showHeadline?: boolean;
}

export default function HowMealioWorks({ showHeadline = true }: Props) {
  return (
    <View>
      {showHeadline && <Text style={styles.headline}>{PITCH_HEADLINE}</Text>}
      <Text style={styles.subhead}>{PITCH_SUBHEAD}</Text>

      <View style={styles.steps}>
        {PITCH_STEPS.map((step, i) => (
          <View key={step.title} style={styles.step}>
            <View style={styles.stepNumber}>
              <Text style={styles.stepNumberText}>{i + 1}</Text>
            </View>
            <View style={styles.stepBody}>
              <Text style={styles.stepTitle}>{step.title}</Text>
              <Text style={styles.stepText}>{step.body}</Text>
            </View>
          </View>
        ))}
      </View>

      <View style={styles.note}>
        <Text style={styles.noteText}>{PITCH_NOTHING_ORDERED}</Text>
      </View>
      <Text style={styles.freeTier}>{PITCH_FREE_TIER}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  headline: {
    fontSize: 24,
    fontFamily: 'Inter_700Bold',
    color: Colors.text1,
    marginBottom: 8,
    lineHeight: 30,
  },
  subhead: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    lineHeight: 22,
  },
  steps: { marginTop: 20, gap: 16 },
  step: { flexDirection: 'row', gap: 12 },
  stepNumber: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: Colors.brandLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumberText: { fontSize: 13, fontFamily: 'Inter_700Bold', color: Colors.brand },
  stepBody: { flex: 1 },
  stepTitle: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text1,
    marginBottom: 2,
  },
  stepText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    lineHeight: 20,
  },
  note: {
    marginTop: 20,
    backgroundColor: Colors.surface,
    borderRadius: Radius.input,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
  },
  noteText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    lineHeight: 19,
  },
  freeTier: {
    marginTop: 12,
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    color: Colors.text3,
  },
});
