import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { AuthStackParamList } from '../../navigation/AuthStack';
import { auth } from '../../lib/api';
import { Colors } from '../../constants/colors';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';

type Props = { navigation: NativeStackNavigationProp<AuthStackParamList, 'Signup'> };

function getPasswordStrength(password: string): { score: number; label: string; color: string } {
  let score = 0;
  if (password.length >= 8) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  if (score <= 1) return { score, label: 'Weak', color: Colors.error };
  if (score === 2) return { score, label: 'Fair', color: '#F59E0B' };
  if (score === 3) return { score, label: 'Good', color: '#3B82F6' };
  return { score, label: 'Strong', color: Colors.success };
}

export default function SignupScreen({ navigation }: Props) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const strength = password ? getPasswordStrength(password) : null;

  function validate() {
    const e: Record<string, string> = {};
    if (!firstName.trim()) e.firstName = 'First name is required';
    if (!lastName.trim()) e.lastName = 'Last name is required';
    if (!email.trim()) e.email = 'Email is required';
    else if (!/\S+@\S+\.\S+/.test(email)) e.email = 'Invalid email';
    if (!password) e.password = 'Password is required';
    else if (password.length < 8) e.password = 'Password must be at least 8 characters';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSignup() {
    if (!validate()) return;
    setLoading(true);
    try {
      await auth.register(firstName.trim(), lastName.trim(), email.trim().toLowerCase(), password);
      navigation.navigate('CheckEmail', { email: email.trim().toLowerCase() });
    } catch (err: any) {
      Alert.alert('Signup Failed', err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" enableOnAndroid extraScrollHeight={24}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Text style={styles.backText}>← Back</Text>
          </TouchableOpacity>

          <Text style={styles.title}>Create account</Text>
          <Text style={styles.subtitle}>Start saving meals today — free forever.</Text>

          <View style={styles.row}>
            <View style={{ flex: 1, marginRight: 8 }}>
              <Input
                label="First name"
                placeholder="Jane"
                value={firstName}
                onChangeText={setFirstName}
                autoComplete="given-name"
                error={errors.firstName}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Input
                label="Last name"
                placeholder="Smith"
                value={lastName}
                onChangeText={setLastName}
                autoComplete="family-name"
                error={errors.lastName}
              />
            </View>
          </View>

          <Input
            label="Email"
            placeholder="you@example.com"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoComplete="email"
            error={errors.email}
          />

          <Input
            label="Password"
            placeholder="Min. 8 characters"
            value={password}
            onChangeText={setPassword}
            isPassword
            autoComplete="new-password"
            error={errors.password}
          />

          {strength && (
            <View style={styles.strengthContainer}>
              <View style={styles.strengthBars}>
                {[1, 2, 3, 4].map((i) => (
                  <View
                    key={i}
                    style={[
                      styles.strengthBar,
                      { backgroundColor: i <= strength.score ? strength.color : Colors.border },
                    ]}
                  />
                ))}
              </View>
              <Text style={[styles.strengthLabel, { color: strength.color }]}>{strength.label}</Text>
            </View>
          )}

          <Button label="Create Account" onPress={handleSignup} loading={loading} style={styles.submitBtn} />
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  scroll: { flexGrow: 1, paddingHorizontal: 24, paddingBottom: 40, paddingTop: 16 },
  backBtn: { marginBottom: 24 },
  backText: { fontSize: 16, color: Colors.brand, fontFamily: 'Inter_500Medium' },
  title: { fontSize: 28, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 8 },
  subtitle: { fontSize: 16, fontFamily: 'Inter_400Regular', color: Colors.text2, marginBottom: 24 },
  row: { flexDirection: 'row' },
  strengthContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: -8,
    marginBottom: 16,
  },
  strengthBars: { flexDirection: 'row', flex: 1, gap: 4 },
  strengthBar: { flex: 1, height: 4, borderRadius: 2 },
  strengthLabel: { fontSize: 12, fontFamily: 'Inter_500Medium', marginLeft: 8, width: 48 },
  submitBtn: { marginTop: 8 },
});
