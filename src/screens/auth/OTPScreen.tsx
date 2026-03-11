import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { AuthStackParamList } from '../../navigation/AuthStack';
import { useAuth } from '../../context/AuthContext';
import { auth } from '../../lib/api';
import { Colors } from '../../constants/colors';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'OTP'>;
  route: RouteProp<AuthStackParamList, 'OTP'>;
};

const COOLDOWN = 30;

export default function OTPScreen({ navigation, route }: Props) {
  const { twoFactorToken, email } = route.params;
  const { verify2FA } = useAuth();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function handleVerify() {
    if (code.length !== 6) {
      Alert.alert('Error', 'Please enter the 6-digit code');
      return;
    }
    setLoading(true);
    try {
      await verify2FA(twoFactorToken, code);
      // AuthContext updates user, RootNavigator handles redirect
    } catch (err: any) {
      Alert.alert('Invalid Code', err.message || 'The code was incorrect or has expired');
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    try {
      await auth.resend2FA(twoFactorToken);
      setCooldown(COOLDOWN);
      Alert.alert('Sent!', 'A new code has been sent to your device.');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not resend code');
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.container}>
          <Text style={styles.icon}>🔐</Text>
          <Text style={styles.title}>Two-factor authentication</Text>
          <Text style={styles.body}>
            Enter the 6-digit code sent to {email}.
          </Text>

          <Input
            placeholder="000000"
            value={code}
            onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
            keyboardType="number-pad"
            containerStyle={styles.codeInput}
            style={{ textAlign: 'center', fontSize: 24, letterSpacing: 8 }}
            maxLength={6}
          />

          <Button label="Verify" onPress={handleVerify} loading={loading} style={styles.verifyBtn} />

          <Button
            label={cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
            variant="ghost"
            onPress={handleResend}
            disabled={cooldown > 0}
          />

          <Button
            label="Back to sign in"
            variant="ghost"
            onPress={() => navigation.navigate('Login')}
            style={styles.backBtn}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  container: { flex: 1, padding: 24, justifyContent: 'center' },
  icon: { fontSize: 48, textAlign: 'center', marginBottom: 20 },
  title: {
    fontSize: 24,
    fontFamily: 'Inter_700Bold',
    color: Colors.text1,
    marginBottom: 8,
    textAlign: 'center',
  },
  body: {
    fontSize: 16,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 24,
  },
  codeInput: { marginBottom: 20 },
  verifyBtn: { marginBottom: 12 },
  backBtn: { marginTop: 8 },
});
