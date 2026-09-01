import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Colors } from '../constants/colors';
import SHEET_META from '../../assets/anim/bag-fill.json';

// What the user watches while the network rail works.
//
// The rail loads no pages, so there is nothing to look at and nothing to do.
// This fills that space with a Mealio bag that visibly fills up as items land.
//
// It is a SPRITE SHEET, not code-drawn art: frames of a Mealio paper bag going from
// empty to overflowing, supplied as a single WebP. Earlier passes drew the bag
// by hand in SVG and it looked hand-drawn, because it was. Playing real frames
// is the only way this looks like it came out of a studio.
//
// The frame IS the progress. frame = round(done / total * lastFrame), so a bag
// that looks two-thirds full is two-thirds done — nothing here is decorative
// timing pretending to be a measurement.

const { frames: FRAMES, cols: COLS, frameWidth: FW, frameHeight: FH } = SHEET_META;
const LAST = FRAMES - 1;

/** On-screen height. The sheet is authored taller so it stays crisp at 3x. */
const DISPLAY_H = 232;
const SCALE = DISPLAY_H / FH;
const DISPLAY_W = Math.round(FW * SCALE);

interface Props {
  /**
   * How far along the whole run is, 0..1 — or null while that is not knowable
   * yet (the login check, before the session answers).
   *
   * ONE number for the ENTIRE run, not per phase. It used to take done/total,
   * and the search and add passes each counted their own list from zero, so the
   * bag filled, emptied and filled again in front of the user. The caller owns
   * the split now and only ever moves this forward.
   */
  progress: number | null;
  label?: string | null;
  title?: string | null;
  /** A second, quieter line. Used to say "still working" when a run stalls. */
  note?: string | null;
}

export default function CartRunAnimation({ progress, label, title, note }: Props) {
  const indeterminate = progress == null;
  const pct = indeterminate ? 0 : Math.max(0, Math.min(1, progress));
  const target = indeterminate ? 0 : Math.round(pct * LAST);

  // The bag fills THROUGH the intermediate frames rather than jumping. An item
  // landing should read as the bag getting fuller, and a cut does not.
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (frame === target) return;
    const step = setTimeout(() => setFrame((f) => (f < target ? f + 1 : f - 1)), 45);
    return () => clearTimeout(step);
  }, [frame, target]);

  const bob = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(bob, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(bob, { toValue: 0, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [bob]);
  const bobY = bob.interpolate({ inputRange: [0, 1], outputRange: [0, -5] });

  const col = frame % COLS;
  const row = Math.floor(frame / COLS);

  return (
    <View style={styles.wrap} testID="cart-run-animation">
      <Animated.View style={[styles.stage, { transform: [{ translateY: bobY }] }]}>
        {/* A window onto one cell of the sheet: the sheet is drawn at display
            scale and slid so the wanted frame lands in the window. */}
        <View style={styles.window} testID="bag-frame-window">
          <Image
            source={require('../../assets/anim/bag-fill.webp')}
            style={{
              width: DISPLAY_W * COLS,
              height: DISPLAY_H * Math.ceil(FRAMES / COLS),
              transform: [{ translateX: -col * DISPLAY_W }, { translateY: -row * DISPLAY_H }],
            }}
            contentFit="fill"
            // The whole sheet is one decode; caching it keeps the frame steps
            // free rather than re-reading the file once per frame.
            cachePolicy="memory-disk"
            transition={0}
          />
        </View>
      </Animated.View>

      <Text style={styles.title}>{title || 'Filling your cart'}</Text>
      {!!label && <Text style={styles.label} numberOfLines={1} testID="cart-run-label">{label}</Text>}
      {!!note && <Text style={styles.note} testID="cart-run-note">{note}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  stage: { width: DISPLAY_W, height: DISPLAY_H, alignItems: 'center', justifyContent: 'center' },
  window: { width: DISPLAY_W, height: DISPLAY_H, overflow: 'hidden' },
  title: { marginTop: 12, fontSize: 17, fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  note: { marginTop: 8, fontSize: 12, color: Colors.text3, opacity: 0.8, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  label: { marginTop: 6, fontSize: 13, color: Colors.text3, fontFamily: 'Inter_400Regular', textAlign: 'center' },
});
