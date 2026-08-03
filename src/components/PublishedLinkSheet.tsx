import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { Feather } from '@expo/vector-icons';
import { Colors, Radius } from '../constants/colors';
import { PresetMeal } from '../types';
import { captionGuidance, detectSourcePlatform, mealShareUrl } from '../lib/sourcePlatform';
import Button from './ui/Button';

interface PublishedLinkSheetProps {
  visible: boolean;
  meal: PresetMeal | null;
  onClose: () => void;
}

export default function PublishedLinkSheet({ visible, meal, onClose }: PublishedLinkSheetProps) {
  const [copied, setCopied] = useState(false);

  if (!meal) return null;

  const url = mealShareUrl(meal.id);
  const guidance = captionGuidance(detectSourcePlatform(meal.source));

  async function handleCopy() {
    await Clipboard.setStringAsync(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <View style={styles.liveBadge}>
            <Feather name="check" size={12} color={Colors.success} />
            <Text style={styles.liveBadgeText}>Live in Discover</Text>
          </View>
          <TouchableOpacity onPress={onClose} accessibilityLabel="Close">
            <Text style={styles.close}>✕</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.body}>
          <Text style={styles.mealName} numberOfLines={2}>{meal.name}</Text>
          <Text style={styles.title}>{guidance.title}</Text>
          <Text style={styles.bodyText}>{guidance.body}</Text>

          <View style={styles.linkBox}>
            <Text style={styles.linkText} numberOfLines={2} selectable>{url}</Text>
          </View>

          <Button
            label={copied ? '✓ Copied' : 'Copy link'}
            onPress={handleCopy}
            style={styles.copyBtn}
          />
          <TouchableOpacity
            style={styles.shareRow}
            onPress={() => Share.share({ message: url, url })}
            activeOpacity={0.8}
          >
            <Feather name="share-2" size={14} color={Colors.brand} />
            <Text style={styles.shareText}>Share it somewhere else</Text>
          </TouchableOpacity>

          {guidance.note && (
            <View style={styles.note}>
              <Feather name="clock" size={14} color={Colors.text2} style={{ marginTop: 2 }} />
              <Text style={styles.noteText}>{guidance.note}</Text>
            </View>
          )}
        </View>

        <View style={styles.footer}>
          <Button label="Done" variant="secondary" onPress={onClose} />
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
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#F0FDF4',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  liveBadgeText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: Colors.success },
  close: { fontSize: 20, color: Colors.text3 },
  body: { flex: 1, padding: 16 },
  mealName: { fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.text3, marginBottom: 6 },
  title: { fontSize: 22, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 8 },
  bodyText: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text2, lineHeight: 21, marginBottom: 16 },
  linkBox: {
    backgroundColor: Colors.surfaceRaised,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    padding: 12,
    marginBottom: 10,
  },
  linkText: { fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.brand },
  copyBtn: { marginBottom: 12 },
  shareRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 4 },
  shareText: { fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.brand },
  note: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    padding: 12,
    marginTop: 20,
  },
  noteText: { flex: 1, fontSize: 12.5, fontFamily: 'Inter_400Regular', color: Colors.text2, lineHeight: 18 },
  footer: { padding: 16, borderTopWidth: 1, borderTopColor: Colors.border },
});
