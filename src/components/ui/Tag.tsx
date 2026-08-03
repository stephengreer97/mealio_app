import React from 'react';
import { TouchableOpacity, Text, StyleSheet, ViewStyle } from 'react-native';
import { Colors } from '../../constants/colors';

interface TagProps {
  label: string;
  selected?: boolean;
  /**
   * Offered but not choosable right now — a tag beyond the cap on a picker that
   * is already full. Faded rather than hidden: which tags exist should not
   * change as you pick, or the list reflows under your thumb.
   */
  disabled?: boolean;
  onPress?: () => void;
  style?: ViewStyle;
}

export default function Tag({ label, selected, disabled, onPress, style }: TagProps) {
  return (
    <TouchableOpacity
      style={[styles.tag, selected && styles.selected, disabled && styles.disabled, style]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityState={{ selected, disabled }}
      activeOpacity={onPress && !disabled ? 0.7 : 1}
    >
      <Text style={[styles.text, selected && styles.selectedText]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  tag: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    marginRight: 8,
    marginBottom: 8,
  },
  selected: {
    backgroundColor: Colors.brandLight,
    borderColor: Colors.brand,
  },
  disabled: {
    opacity: 0.4,
  },
  text: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
  },
  selectedText: {
    color: Colors.brand,
    fontFamily: 'Inter_500Medium',
  },
});
