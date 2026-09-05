import React from 'react';
import { View, Text, StyleSheet, Modal, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius } from '../constants/colors';
import { PITCH_NOTHING_ORDERED } from '../constants/pitch';
import Button from './ui/Button';

// What Choose Products is, said before it starts (MEAL-84).
//
// Choose Products is a new user's first real interaction with Mealio: up to a
// dozen modal screens in a row, each asking which store product matches an
// ingredient. Read cold it looks like the cart being filled one slow item at a
// time, which is why people abandon it halfway — they think they are watching
// the shopping happen and it is taking forever.
//
// It is none of those things: it is one-time matching, it saves, and it puts
// nothing in the cart. That is what this sheet says, and it says it *before* the
// run rather than on the completion screen where the reassurance used to live.
//
// It explains; it does not gate. "Choose products" starts the same flow the
// floating button always started, one tap away, and this sheet is shown once per
// device either way (see lib/firstRun.ts).

interface Props {
  visible: boolean;
  storeName: string;
  /** Ingredients still without a chosen product, across the selected meals. */
  ingredientCount: number;
  /** Meals in this run — the flow walks them back to back. */
  mealCount: number;
  onStart: () => void;
  onCancel: () => void;
}

export default function ChooseProductsIntroSheet({
  visible, storeName, ingredientCount, mealCount, onStart, onCancel,
}: Props) {
  const items = ingredientCount === 1 ? '1 ingredient' : `${ingredientCount} ingredients`;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onCancel}
      testID="choose-products-intro"
    >
      <View style={styles.root}>
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={onCancel}
          accessibilityLabel="Close"
          testID="choose-products-intro-backdrop"
        />
        <SafeAreaView style={styles.card} edges={['bottom']}>
          <View style={styles.header}>
            <View style={styles.headerIcon}>
              <Ionicons name="search" size={18} color={Colors.brand} />
            </View>
            <Text style={styles.title}>First, match your ingredients</Text>
            <TouchableOpacity
              onPress={onCancel}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={22} color={Colors.text3} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.scroll}>
            <Text style={styles.body}>
              A recipe asks for sour cream; {storeName} stocks a dozen different ones. Mealio needs
              to know which one you buy, so it will show you {items}
              {mealCount > 1 ? ` from your ${mealCount} meals` : ''}, one at a time, with the{' '}
              {storeName} products that match.
            </Text>

            <View style={styles.point}>
              <Ionicons name="repeat" size={18} color={Colors.text2} style={styles.pointIcon} />
              <Text style={styles.pointText}>
                <Text style={styles.pointLead}>You do this once. </Text>
                Mealio remembers what you picked, so the next time you shop this meal it goes
                straight into the cart.
              </Text>
            </View>

            <View style={styles.point}>
              <Ionicons name="flag-outline" size={18} color={Colors.text2} style={styles.pointIcon} />
              <Text style={styles.pointText}>
                <Text style={styles.pointLead}>At the end, </Text>
                your picks are saved and you are back at your meals, with the button now offering
                to add them all to your {storeName} cart.
              </Text>
            </View>

            <View style={styles.note}>
              <Text style={styles.noteText}>{PITCH_NOTHING_ORDERED}</Text>
            </View>
          </ScrollView>

          <View style={styles.footer}>
            <Button
              label={`Choose products (${ingredientCount})`}
              size="lg"
              onPress={onStart}
              style={{ width: '100%' }}
              testID="choose-products-intro-start"
            />
            <Button
              label="Not now"
              variant="ghost"
              onPress={onCancel}
              style={{ width: '100%', marginTop: 4 }}
              testID="choose-products-intro-cancel"
            />
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  card: {
    backgroundColor: Colors.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '90%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 12,
  },
  headerIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.brandLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { flex: 1, fontSize: 19, fontFamily: 'Inter_700Bold', color: Colors.text1 },
  scroll: { paddingHorizontal: 20, paddingBottom: 8 },
  body: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    lineHeight: 22,
  },
  point: { flexDirection: 'row', gap: 10, marginTop: 16 },
  pointIcon: { marginTop: 2 },
  pointText: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    lineHeight: 20,
  },
  pointLead: { fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  note: {
    marginTop: 18,
    backgroundColor: Colors.surface,
    borderRadius: Radius.input,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
  },
  noteText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    lineHeight: 19,
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
});
