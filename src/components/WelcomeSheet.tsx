import React from 'react';
import { View, Text, StyleSheet, Modal, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../constants/colors';
import HowMealioWorks from './HowMealioWorks';
import Button from './ui/Button';

// The first thing a new install shows: what Mealio is (MEAL-84).
//
// Discover is the front door for signed-out and signed-in users alike, and
// before this it showed a first-time visitor a grid of recipe photos and never
// once said that Mealio puts a meal's ingredients into their grocery cart — the
// only claim that separates it from every other recipe app.
//
// It is a card over Discover, not a route: dismissing it lands on exactly the
// screen that was already loading behind it. There is nothing to agree to and
// nothing to fill in, so the ✕ and the backdrop dismiss it as readily as the
// button does — all three are the same action.

interface Props {
  visible: boolean;
  onDismiss: () => void;
}

export default function WelcomeSheet({ visible, onDismiss }: Props) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onDismiss}
      testID="welcome-sheet"
    >
      <View style={styles.root}>
        {/* Tapping outside is a dismissal like any other — nothing here is a
            decision, so it does not deserve a confirmation. */}
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={onDismiss}
          accessibilityLabel="Close"
          testID="welcome-backdrop"
        />
        <SafeAreaView style={styles.card} edges={['bottom']}>
          <View style={styles.grabberRow}>
            <View style={styles.grabber} />
            <TouchableOpacity
              style={styles.closeBtn}
              onPress={onDismiss}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={22} color={Colors.text3} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.scroll}>
            <Text style={styles.logo}>Mealio</Text>
            <HowMealioWorks />
          </ScrollView>

          <View style={styles.footer}>
            <Button label="Browse meals" size="lg" onPress={onDismiss} style={{ width: '100%' }} />
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
  grabberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 10,
    paddingHorizontal: 12,
  },
  grabber: { width: 36, height: 4, borderRadius: 2, backgroundColor: Colors.borderStrong },
  closeBtn: { position: 'absolute', right: 12, top: 4, padding: 4 },
  scroll: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
  logo: {
    fontSize: 30,
    fontFamily: 'Pacifico_400Regular',
    color: Colors.brand,
    marginBottom: 12,
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
});
