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

type Props = { navigation: NativeStackNavigationProp<AuthStackParamList, 'ForgotPassword'> };

export default function ForgotPasswordScreen({ navigation }: Props) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit() {
    if (!email.trim() || !/\S+@\S+\.\S+/.test(email)) {
      Alert.alert('Error', 'Please enter a valid email');
      return;
    }
    setLoading(true);
    try {
      await auth.forgotPassword(email.trim().toLowerCase());
      setSent(true);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAwareScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled" enableOnAndroid extraScrollHeight={24}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Text style={styles.backText}>← Back</Text>
          </TouchableOpacity>

          {!sent ? (
            <>
              <Text style={styles.title}>Reset password</Text>
              <Text style={styles.body}>
                Enter your email and we'll send you a link to reset your password.
              </Text>

              <Input
                label="Email"
                placeholder="you@example.com"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoComplete="email"
              />

              <Button label="Send Reset Link" onPress={handleSubmit} loading={loading} />
            </>
          ) : (
            <>
              <Text style={styles.icon}>✉️</Text>
              <Text style={styles.title}>Check your email</Text>
              <Text style={styles.body}>
                We've sent a password reset link to{' '}
                <Text style={styles.emailText}>{email}</Text>.{'\n\n'}
                Click the link to reset your password on mealio.co, then return here to sign in.
              </Text>
              <Button
                label="Back to sign in"
                onPress={() => navigation.navigate('Login')}
              />
            </>
          )}
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  container: { flex: 1, padding: 24, paddingTop: 16 },
  backBtn: { marginBottom: 32 },
  backText: { fontSize: 16, color: Colors.brand, fontFamily: 'Inter_500Medium' },
  icon: { fontSize: 48, textAlign: 'center', marginBottom: 20 },
  title: { fontSize: 28, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 12 },
  body: {
    fontSize: 16,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    lineHeight: 24,
    marginBottom: 24,
  },
  emailText: { fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
});
