import React, { useState } from 'react';
import {
  TextInput,
  TextInputProps,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius } from '../../constants/colors';

interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
  containerStyle?: ViewStyle;
  isPassword?: boolean;
}

export default function Input({ label, error, containerStyle, isPassword, style, ...props }: InputProps) {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <View style={[styles.container, containerStyle]}>
      {label && <Text style={styles.label}>{label}</Text>}
      <View style={[styles.inputWrapper, error && styles.inputError]}>
        <TextInput
          style={[styles.input, style]}
          placeholderTextColor={Colors.text3}
          secureTextEntry={isPassword && !showPassword}
          autoCapitalize={isPassword || props.keyboardType === 'email-address' ? 'none' : 'sentences'}
          {...props}
        />
        {isPassword && (
          <TouchableOpacity onPress={() => setShowPassword((v) => !v)} style={styles.eyeBtn}>
            <Ionicons
              name={showPassword ? 'eye-off-outline' : 'eye-outline'}
              size={20}
              color={Colors.text3}
            />
          </TouchableOpacity>
        )}
      </View>
      {error && <Text style={styles.errorText}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: 16 },
  label: {
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
    color: Colors.text2,
    marginBottom: 6,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceRaised,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
  },
  inputError: {
    borderColor: Colors.error,
  },
  input: {
    flex: 1,
    fontSize: 16,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
    paddingVertical: 12,
    letterSpacing: 0,
  },
  eyeBtn: { padding: 4 },
  errorText: {
    fontSize: 12,
    color: Colors.error,
    marginTop: 4,
    fontFamily: 'Inter_400Regular',
  },
});
