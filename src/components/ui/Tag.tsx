import React from 'react';
import { TouchableOpacity, Text, StyleSheet, ViewStyle } from 'react-native';
import { Colors } from '../../constants/colors';

interface TagProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  style?: ViewStyle;
}

export default function Tag({ label, selected, onPress, style }: TagProps) {
  return (
    <TouchableOpacity
      style={[styles.tag, selected && styles.selected, style]}
      onPress={onPress}
      activeOpacity={onPress ? 0.7 : 1}
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
