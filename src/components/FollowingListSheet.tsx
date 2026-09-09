import React, { useState } from 'react';
import { Modal, View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Colors } from '../constants/colors';
import { Creator } from '../types';
import { creators as creatorsApi } from '../lib/api';
import Button from './ui/Button';

/**
 * Everyone you follow, in one scrollable list.
 *
 * The strip at the top of the Following feed holds the first few faces and
 * scrolls sideways; past about five, sideways scrolling is a poor way to answer
 * "who am I following?" and no way at all to answer "who do I want to stop
 * following?". This is that list: a name to open the creator, and an Unfollow
 * beside it.
 *
 * It owns no copy of the list. Unfollowing tells the caller, which re-reads and
 * passes the shorter list back down, so this sheet and the strip behind it
 * cannot disagree about who you follow.
 */
export default function FollowingListSheet({
  visible, creators, onClose, onOpenCreator, onUnfollowed,
}: {
  visible: boolean;
  creators: Creator[];
  onClose: () => void;
  onOpenCreator: (creatorId: string) => void;
  onUnfollowed: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function unfollow(creator: Creator) {
    setBusyId(creator.id);
    try {
      await creatorsApi.unfollow(creator.id);
      onUnfollowed();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Could not unfollow');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.close}>✕</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Following ({creators.length})</Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView contentContainerStyle={styles.list}>
          {creators.length === 0 ? (
            <Text style={styles.empty}>You are not following anyone yet.</Text>
          ) : (
            creators.map((creator) => (
              <View key={creator.id} style={styles.row}>
                <TouchableOpacity
                  style={styles.rowMain}
                  testID={`following-row-${creator.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`View ${creator.displayName}'s profile`}
                  onPress={() => onOpenCreator(creator.id)}
                >
                  {creator.photoUrl ? (
                    <Image source={{ uri: creator.photoUrl }} style={styles.avatar} contentFit="cover" />
                  ) : (
                    <View style={[styles.avatar, styles.avatarPlaceholder]}>
                      <Text style={styles.avatarText}>{creator.displayName?.[0]?.toUpperCase() ?? '?'}</Text>
                    </View>
                  )}
                  <Text style={styles.name} numberOfLines={1}>{creator.displayName}</Text>
                </TouchableOpacity>
                <Button
                  label={busyId === creator.id ? 'Unfollowing' : 'Unfollow'}
                  variant="ghost"
                  size="sm"
                  disabled={busyId === creator.id}
                  onPress={() => unfollow(creator)}
                />
              </View>
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  close: { fontSize: 20, color: Colors.text2, width: 40 },
  title: { flex: 1, textAlign: 'center', fontSize: 16, fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  headerSpacer: { width: 40 },
  list: { padding: 16 },
  empty: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text3, textAlign: 'center', marginTop: 24 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  avatar: { width: 40, height: 40, borderRadius: 20, marginRight: 12, backgroundColor: Colors.surface },
  avatarPlaceholder: { backgroundColor: Colors.brand, justifyContent: 'center', alignItems: 'center' },
  avatarText: { fontSize: 17, fontFamily: 'Inter_700Bold', color: '#fff' },
  name: { flex: 1, fontSize: 15, fontFamily: 'Inter_500Medium', color: Colors.text1 },
});
