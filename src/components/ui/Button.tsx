import React from 'react';
import {
  TouchableOpacity,
  Text,
  ActivityIndicator,
  StyleSheet,
  TouchableOpacityProps,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { Colors, Radius } from '../../constants/colors';

interface ButtonProps extends TouchableOpacityProps {
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  style?: ViewStyle;
  textStyle?: TextStyle;
}

export default function Button({
  label,
  variant = 'primary',
  size = 'md',
  loading = false,
  style,
  textStyle,
  disabled,
  ...props
}: ButtonProps) {
  const variantStyle = styles[variant];
  const variantText = textStyles[variant];
  const sizeStyle = sizeStyles[size];
  const sizeText = sizeTextStyles[size];

  return (
    <TouchableOpacity
      style={[styles.base, variantStyle, sizeStyle, (disabled || loading) && styles.disabled, style]}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? '#fff' : Colors.brand} size="small" />
      ) : (
        <Text style={[styles.text, variantText, sizeText, textStyle]}>{label}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: Radius.button,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: {
    backgroundColor: Colors.brand,
  },
  secondary: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  ghost: {
    backgroundColor: 'transparent',
  },
  danger: {
    backgroundColor: Colors.error,
  },
  disabled: {
    opacity: 0.5,
  },
  text: {
    fontFamily: 'Inter_600SemiBold',
  },
});

const textStyles = StyleSheet.create({
  primary: { color: '#fff' },
  secondary: { color: Colors.text1 },
  ghost: { color: Colors.brand },
  danger: { color: '#fff' },
});

const sizeStyles = StyleSheet.create({
  sm: { paddingVertical: 8, paddingHorizontal: 16 },
  md: { paddingVertical: 12, paddingHorizontal: 20 },
  lg: { paddingVertical: 16, paddingHorizontal: 24 },
});

const sizeTextStyles = StyleSheet.create({
  sm: { fontSize: 14 },
  md: { fontSize: 16 },
  lg: { fontSize: 18 },
});
