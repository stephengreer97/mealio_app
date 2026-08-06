import React, { useRef } from 'react';
import { Animated, Modal, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';

/** Downward travel (px) that dismisses the viewer on release. */
const SWIPE_DISMISS_DY = 120;
/** Vertical travel (px) before we claim the touch as a swipe rather than a tap. */
const SWIPE_CLAIM_DY = 6;

interface Props {
  /** Product photo to show. Nothing renders without one. */
  uri: string | null;
  visible: boolean;
  onClose: () => void;
}

/**
 * Full-screen product photo, opened from the 80–88px preview thumbnails in the
 * Choose Product and reconcile flows (MEAL-64). Those thumbnails are the only
 * image on screen at the moment the user is asked "is this the right product?",
 * and until now there was no way to see one at a readable size.
 *
 * Four ways out, because this sits on top of a sheet that is itself a modal and
 * a user who cannot dismiss it is stuck mid-run: the ✕, a tap anywhere, a
 * downward swipe, and the Android hardware back button (onRequestClose).
 *
 * The swipe claims the touch only once it has moved vertically — below that
 * threshold the touch stays with the backdrop Pressable, so a tap on the photo
 * itself still closes rather than dying on the swipe handler.
 */
export default function ProductImageViewer({ uri, visible, onClose }: Props) {
  const dragY = useRef(new Animated.Value(0)).current;
  // The responder is built once and would otherwise hold the first render's
  // onClose forever.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dy) > SWIPE_CLAIM_DY && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_, g) => { if (g.dy > 0) dragY.setValue(g.dy); },
      onPanResponderRelease: (_, g) => {
        if (g.dy > SWIPE_DISMISS_DY) { dragY.setValue(0); onCloseRef.current(); return; }
        Animated.spring(dragY, { toValue: 0, useNativeDriver: true }).start();
      },
      onPanResponderTerminate: () => { dragY.setValue(0); },
    }),
  ).current;

  return (
    <Modal
      visible={visible && !!uri}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} testID="product-image-viewer-backdrop">
        <Animated.View
          style={[styles.imageWrap, { transform: [{ translateY: dragY }] }]}
          {...responder.panHandlers}
        >
          {uri ? (
            <Image
              testID="product-image-viewer-image"
              source={{ uri }}
              style={styles.image}
              contentFit="contain"
            />
          ) : null}
        </Animated.View>
      </Pressable>

      {/* Rendered after the backdrop so it paints above it and takes the tap. */}
      <SafeAreaView style={styles.closeLayer} pointerEvents="box-none" edges={['top']}>
        <View style={styles.closeRow} pointerEvents="box-none">
          <Pressable
            testID="product-image-viewer-close"
            onPress={onClose}
            style={styles.closeBtn}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Close photo"
          >
            <Ionicons name="close" size={24} color="#fff" />
          </Pressable>
        </View>
        <View style={styles.hintRow} pointerEvents="none">
          <Text style={styles.hint}>Tap anywhere or swipe down to close</Text>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  imageWrap: { width: '100%', height: '80%' },
  image: { width: '100%', height: '100%' },
  closeLayer: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between' },
  closeRow: { flexDirection: 'row', justifyContent: 'flex-end', padding: 12 },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hintRow: { alignItems: 'center', paddingBottom: 28 },
  hint: { fontSize: 12, fontFamily: 'Inter_400Regular', color: 'rgba(255,255,255,0.6)' },
});
