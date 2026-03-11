import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { AuthStackParamList } from '../../navigation/AuthStack';
import { auth } from '../../lib/api';
import { Colors } from '../../constants/colors';
import Button from '../../components/ui/Button';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'CheckEmail'>;
  route: RouteProp<AuthStackParamList, 'CheckEmail'>;
};

const COOLDOWN = 60;

export default function CheckEmailScreen({ navigation, route }: Props) {
  const { email } = route.params;
  const [cooldown, setCooldown] = useState(COOLDOWN);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function handleResend() {
    setLoading(true);
    try {
      await auth.resendVerification(email);
      setCooldown(COOLDOWN);
      Alert.alert('Sent!', 'Check your inbox for the verification email.');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not send email');
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Text style={styles.icon}>📬</Text>
        <Text style={styles.title}>Check your email</Text>
        <Text style={styles.body}>
          We sent a verification link to{' '}
          <Text style={styles.email}>{email}</Text>.{'\n\n'}
          Click the link in the email to verify your account, then come back and sign in.
        </Text>

        <Button
          label={cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend email'}
          variant="secondary"
          onPress={handleResend}
          loading={loading}
          disabled={cooldown > 0}
          style={styles.resendBtn}
        />

        <Button
          label="Back to sign in"
          variant="ghost"
          onPress={() => navigation.navigate('Login')}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  container: { flex: 1, padding: 24, justifyContent: 'center', alignItems: 'center' },
  icon: { fontSize: 64, marginBottom: 24 },
  title: {
    fontSize: 28,
    fontFamily: 'Inter_700Bold',
    color: Colors.text1,
    marginBottom: 16,
    textAlign: 'center',
  },
  body: {
    fontSize: 16,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 32,
  },
  email: { fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  resendBtn: { width: '100%', marginBottom: 12 },
});
