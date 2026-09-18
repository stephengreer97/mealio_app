import React from 'react';
import { Text, TouchableOpacity, View, StyleSheet, TextStyle, ViewStyle } from 'react-native';
import { Colors, Radius } from '../constants/colors';

// Small pieces the creator portal's Settings tab is built from: the outline
// button the web portal uses for secondary actions, the amber note, and the
// status badge. Shared so the sync section and the three connect cards read as
// one screen.

export function OutlineButton({
  label,
  onPress,
  disabled,
  testID,
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  style?: ViewStyle;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={[ui.outline, disabled && ui.disabled, style]}
      activeOpacity={0.8}
    >
      <Text style={ui.outlineText}>{label}</Text>
    </TouchableOpacity>
  );
}

export function Note({ children, testID, tone = 'amber' }: { children: React.ReactNode; testID?: string; tone?: 'amber' | 'green' }) {
  return (
    <View style={[ui.note, tone === 'green' && ui.noteGreen]} testID={testID}>
      <Text style={[ui.noteText, tone === 'green' && ui.noteTextGreen]}>{children}</Text>
    </View>
  );
}

export function Badge({ label, tone, testID }: { label: string; tone: 'green' | 'amber' | 'gray' | 'white'; testID?: string }) {
  return (
    <View style={[ui.badge, badgeTone[tone]]} testID={testID}>
      <Text style={[ui.badgeText, badgeText[tone]]}>{label}</Text>
    </View>
  );
}

export const ui = StyleSheet.create({
  eyebrow: { fontSize: 11, fontFamily: 'Inter_600SemiBold', color: Colors.text3, letterSpacing: 1, marginBottom: 2 },
  title: { fontSize: 16, fontFamily: 'Inter_700Bold', color: Colors.text1 },
  subtitle: { fontSize: 14, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 6 },
  body: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text2, lineHeight: 19 },
  strong: { fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  hint: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3, lineHeight: 17 },
  label: { fontSize: 11, fontFamily: 'Inter_600SemiBold', color: Colors.text2, letterSpacing: 0.6, marginBottom: 6 },
  error: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.error, lineHeight: 19 },
  success: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.success, lineHeight: 19 },
  divider: { borderTopWidth: 1, borderTopColor: Colors.border, marginTop: 16, paddingTop: 16 },
  outline: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: Colors.surfaceRaised,
  },
  outlineText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: Colors.text2 },
  disabled: { opacity: 0.5 },
  note: {
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FEF3C7',
    borderRadius: Radius.input,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  noteGreen: { backgroundColor: '#ECFDF5', borderColor: '#D1FAE5' },
  noteText: { fontSize: 13, fontFamily: 'Inter_400Regular', color: '#92400E', lineHeight: 19 },
  noteTextGreen: { color: '#166534' },
  badge: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 2, alignSelf: 'flex-start' },
  badgeText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: Colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
    backgroundColor: Colors.surfaceRaised,
  },
  checkboxOn: { backgroundColor: Colors.brand, borderColor: Colors.brand },
});

const badgeTone: Record<string, ViewStyle> = {
  green: { backgroundColor: '#ECFDF5', borderColor: '#D1FAE5' },
  amber: { backgroundColor: '#FFFBEB', borderColor: '#FEF3C7' },
  gray: { backgroundColor: Colors.surface, borderColor: Colors.border },
  white: { backgroundColor: Colors.surfaceRaised, borderColor: Colors.border },
};

const badgeText: Record<string, TextStyle> = {
  green: { color: Colors.success },
  amber: { color: '#92400E' },
  gray: { color: Colors.text2 },
  white: { color: Colors.text2 },
};
