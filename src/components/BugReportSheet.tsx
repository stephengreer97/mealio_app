import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TextInput,
  TouchableOpacity,
  Platform,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { Colors, Radius } from '../constants/colors';
import { useAuth } from '../context/AuthContext';
import { bugReport } from '../lib/api';
import { getSessionLogs } from '../lib/logBuffer';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Optional screen/route name to attach as context. */
  currentRoute?: string;
}

export default function BugReportSheet({ visible, onClose, currentRoute }: Props) {
  const { user } = useAuth();
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    const text = description.trim();
    if (text.length < 5) {
      Alert.alert('Add a few details', 'Please describe what went wrong so we can help.');
      return;
    }
    setSubmitting(true);
    try {
      await bugReport.submit({
        description: text,
        logs: getSessionLogs(),
        context: {
          appVersion: (Constants.expoConfig as any)?.version ?? null,
          platform: Platform.OS,
          osVersion: String(Platform.Version),
          route: currentRoute ?? null,
          userId: user?.id ?? null,
          tier: (user as any)?.tier ?? null,
        },
      });
      onClose();
      setDescription('');
      Alert.alert('Thanks!', 'Your report was sent. We appreciate you helping us improve Mealio.');
    } catch (err: any) {
      Alert.alert('Could not send', err?.message || 'Please try again in a moment.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Text style={styles.title}>Report a bug</Text>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close" size={26} color={Colors.text2} />
          </TouchableOpacity>
        </View>

        <View style={styles.body}>
          <Text style={styles.label}>What went wrong?</Text>
          <TextInput
            style={styles.input}
            placeholder="Describe the problem — what you were doing and what happened."
            placeholderTextColor={Colors.text3}
            value={description}
            onChangeText={setDescription}
            multiline
            textAlignVertical="top"
            autoFocus
            editable={!submitting}
          />

          <View style={styles.notice}>
            <Ionicons name="shield-checkmark-outline" size={16} color={Colors.text3} />
            <Text style={styles.noticeText}>
              To help us debug, recent diagnostic logs from this session are attached — including
              the meals and items involved. Your password, login tokens, and email are never
              included.
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.submitBtn, submitting && { opacity: 0.6 }]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.submitText}>Send report</Text>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  title: { fontSize: 20, fontFamily: 'Inter_700Bold', color: Colors.text1 },
  body: { padding: 16, gap: 14 },
  label: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text2 },
  input: {
    minHeight: 140,
    backgroundColor: Colors.surfaceRaised,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    padding: 14,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
  },
  notice: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingHorizontal: 2 },
  noticeText: { flex: 1, fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3, lineHeight: 18 },
  submitBtn: {
    backgroundColor: Colors.brand,
    borderRadius: Radius.button,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  submitText: { fontSize: 16, fontFamily: 'Inter_600SemiBold', color: '#fff' },
});
