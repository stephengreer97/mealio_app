import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  PanResponder,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';
import { CartJobStatus } from './WebViewCartSheet';

// Floating, draggable status bubble for a background add-to-cart job.
//   running (with progress) → circular progress ring (store color)
//   running (no count yet)  → spinning arc (login check etc.)
//   done                    → full green ring + check (tap opens cart snapshot)
//   warning                 → amber ring + alert (review / snapshot problem)
// Drag to move (snaps to the nearest side); tap to expand the sheet.

const SIZE = 60;
const STROKE = 4;
const R = (SIZE - STROKE) / 2;
const CIRC = 2 * Math.PI * R;
const MARGIN = 14;
const TAB_BAR_GAP = 84; // keep clear of the bottom tab bar at rest

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export default function CartStatusBubble({
  status,
  storeColor,
  onPress,
}: {
  status: CartJobStatus;
  storeColor: string;
  onPress: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width: SW, height: SH } = Dimensions.get('window');

  const start = {
    x: SW - SIZE - MARGIN,
    y: SH - SIZE - MARGIN - insets.bottom - TAB_BAR_GAP,
  };
  const pos = useRef(new Animated.ValueXY(start)).current;
  const posValue = useRef({ ...start });
  useEffect(() => {
    const id = pos.addListener((v) => { posValue.current = v; });
    return () => pos.removeListener(id);
  }, [pos]);

  const determinate = status.progress != null;
  const indeterminate = !determinate && (status.kind === 'running' || status.kind === 'setup');

  // Indeterminate spinner rotation (login check etc., before any item count).
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (indeterminate) {
      spin.setValue(0);
      const loop = Animated.loop(
        Animated.timing(spin, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: true }),
      );
      loop.start();
      return () => loop.stop();
    }
  }, [indeterminate, spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  // Smoothly animate the determinate progress ring as items complete.
  const progressAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (status.progress != null) {
      Animated.timing(progressAnim, {
        toValue: status.progress,
        duration: 400,
        useNativeDriver: false,
      }).start();
    }
  }, [status.progress, progressAnim]);
  const dashoffset = progressAnim.interpolate({ inputRange: [0, 1], outputRange: [CIRC, 0] });

  const moved = useRef(false);
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4,
      onPanResponderGrant: () => {
        moved.current = false;
        pos.setOffset({ x: posValue.current.x, y: posValue.current.y });
        pos.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: (e, g) => {
        if (Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4) moved.current = true;
        Animated.event([null, { dx: pos.x, dy: pos.y }], { useNativeDriver: false })(e, g);
      },
      onPanResponderRelease: () => {
        pos.flattenOffset();
        if (!moved.current) { onPress(); return; }
        // Snap to the nearest left/right edge; clamp within the safe area.
        const cx = posValue.current.x;
        const cy = posValue.current.y;
        const snapX = cx + SIZE / 2 < SW / 2 ? MARGIN : SW - SIZE - MARGIN;
        const minY = insets.top + MARGIN;
        const maxY = SH - SIZE - MARGIN - insets.bottom;
        const clampY = Math.max(minY, Math.min(maxY, cy));
        Animated.spring(pos, {
          toValue: { x: snapX, y: clampY },
          useNativeDriver: false,
          friction: 7,
        }).start();
      },
    }),
  ).current;

  const isDone = status.kind === 'done';
  const isWarn = status.kind === 'warning' || status.kind === 'attention';
  const accent = isDone ? '#16a34a' : isWarn ? '#f59e0b' : storeColor;
  const icon = isDone ? 'checkmark' : isWarn ? 'alert' : 'cart';

  return (
    <Animated.View
      style={[styles.bubble, { transform: pos.getTranslateTransform() }]}
      accessibilityRole="button"
      accessibilityLabel={`Cart job: ${status.label}. Double tap to open.`}
      {...panResponder.panHandlers}
    >
      <Animated.View style={styles.inner}>
        {determinate ? (
          <Svg width={SIZE} height={SIZE} style={StyleSheet.absoluteFill}>
            <Circle cx={SIZE / 2} cy={SIZE / 2} r={R} stroke="rgba(0,0,0,0.08)" strokeWidth={STROKE} fill="none" />
            <AnimatedCircle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={R}
              stroke={accent}
              strokeWidth={STROKE}
              fill="none"
              strokeLinecap="round"
              strokeDasharray={CIRC}
              strokeDashoffset={dashoffset}
              rotation={-90}
              origin={`${SIZE / 2}, ${SIZE / 2}`}
            />
          </Svg>
        ) : indeterminate ? (
          <Animated.View style={[styles.arc, { borderTopColor: accent, transform: [{ rotate }] }]} />
        ) : (
          <Animated.View style={[styles.ring, { borderColor: accent }]} />
        )}
        <Ionicons name={icon as any} size={24} color={accent} />
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bubble: { position: 'absolute', top: 0, left: 0, width: SIZE, height: SIZE, zIndex: 200, elevation: 200 },
  inner: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  arc: {
    position: 'absolute',
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: 3,
    borderColor: 'rgba(0,0,0,0.08)',
  },
  ring: {
    position: 'absolute',
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: 3,
  },
});
