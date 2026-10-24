import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Modal, TextInput, TouchableOpacity, FlatList } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius } from '../constants/colors';
import { useStores } from '../lib/store-catalog/useStores';
import { filterStores } from '../lib/storeSearch';

// "Your store" on My Meals: the one store the account shops at. Picking one
// here only reports the choice; My Meals asks before moving anything, because a
// switch moves every meal (mealio_central lib/default-store.ts).

interface Props {
  visible: boolean;
  current: string | null;
  onPick: (storeId: string) => void;
  onClose: () => void;
}

export default function StoreSwitcherSheet({ visible, current, onPick, onClose }: Props) {
  const stores = useStores();
  const [query, setQuery] = useState('');
  useEffect(() => { if (!visible) setQuery(''); }, [visible]);

  const list = useMemo(
    () => (query.trim() ? filterStores(stores, query) : stores).slice().sort((a, b) => a.name.localeCompare(b.name)),
    [stores, query],
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Text style={styles.title}>Your store</Text>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityLabel="Close">
            <Text style={styles.close}>✕</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.subtitle}>All your meals go to this store, and every cart runs there.</Text>
        <View style={styles.searchRow}>
          <Ionicons name="search-outline" size={18} color={Colors.text3} style={{ marginRight: 8 }} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search stores"
            placeholderTextColor={Colors.text3}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
            testID="store-switcher-search"
          />
        </View>
        <FlatList
          data={list}
          keyExtractor={(s) => s.id}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const on = item.id === current;
            return (
              <TouchableOpacity
                style={[styles.row, on && styles.rowOn]}
                onPress={() => onPick(item.id)}
                testID={`store-switcher-${item.id}`}
                accessibilityState={{ selected: on }}
              >
                <View style={[styles.dot, { backgroundColor: item.color }]} />
                <Text style={[styles.name, on && styles.nameOn]}>{item.name}</Text>
                {on && <Text style={styles.check}>✓</Text>}
              </TouchableOpacity>
            );
          }}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 20, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  title: { fontSize: 20, fontFamily: 'Inter_700Bold', color: Colors.text1 },
  close: { fontSize: 20, color: Colors.text3 },
  subtitle: { fontSize: 15, fontFamily: 'Inter_400Regular', color: Colors.text2, padding: 20, paddingBottom: 8 },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', marginHorizontal: 20, marginBottom: 12, paddingHorizontal: 12,
    borderRadius: Radius.input, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  searchInput: { flex: 1, paddingVertical: 10, fontSize: 15, fontFamily: 'Inter_400Regular', color: Colors.text1 },
  list: { paddingHorizontal: 20, paddingBottom: 40 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 12,
    borderRadius: Radius.input, marginBottom: 6, backgroundColor: Colors.surfaceRaised, borderWidth: 1, borderColor: Colors.border,
  },
  rowOn: { borderColor: Colors.brand, backgroundColor: Colors.brandLight },
  dot: { width: 12, height: 12, borderRadius: 6 },
  name: { flex: 1, fontSize: 16, fontFamily: 'Inter_500Medium', color: Colors.text1 },
  nameOn: { fontFamily: 'Inter_600SemiBold', color: Colors.brand },
  check: { fontSize: 16, color: Colors.brand },
});
