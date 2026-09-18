import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
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
// The frame IS the progress. frame = round(progress * lastFrame), so a bag that
// looks two-thirds full is two-thirds done: nothing here is decorative timing
// pretending to be a measurement. The bar under it reads the same number.
//
// THE LAYOUT IS THE LAUNCH VIDEO'S (brag-output, 2026-09-18, Stephen: "I want
// the frame sequence in the app to look more like it does in this video"):
// a heading and the meal above the bag, a bold count, a red bar, a quiet line
// that turns into a green tick when the run completes. The bag steps through
// its frames at an even beat and hops as each one lands, then pops on the last.

const { frames: FRAMES, cols: COLS, frameWidth: FW, frameHeight: FH } = SHEET_META;
const LAST = FRAMES - 1;

/** On-screen height. The sheet is authored taller so it stays crisp at 3x. */
const DISPLAY_H = 250;
const SCALE = DISPLAY_H / FH;
const DISPLAY_W = Math.round(FW * SCALE);

/**
 * One frame per beat when catching up to the progress. The video steps every
 * 300ms; a real run can jump several frames at once (a batch write lands), and
 * at 300ms that would lag the truth by seconds, so this is quicker but still
 * reads as frames landing one by one rather than a cut.
 */
const FRAME_STEP_MS = 140;

const BAR_W = 240;

export interface CartRunCount {
  done: number;
  total: number;
  /** "added", "found": what the counted things have had done to them. */
  verb: string;
}

interface Props {
  /**
   * How far along the whole run is, 0..1, or null while that is not knowable
   * yet (the login check, before the session answers).
   *
   * ONE number for the ENTIRE run, not per phase. It used to take done/total,
   * and the search and add passes each counted their own list from zero, so the
   * bag filled, emptied and filled again in front of the user. The caller owns
   * the split now and only ever moves this forward. The bag and the bar both
   * read it; the COUNT below may restart per phase, which is why it names its
   * verb ("found", then "added") rather than being a second overall number.
   */
  progress: number | null;
  /** The quiet line under the bar, e.g. "Adding 12 ingredients". */
  label?: string | null;
  /** The heading above the bag, e.g. "Adding to your cart". */
  title?: string | null;
  /** Under the heading: what is being shopped for, e.g. the meal's name. */
  subtitle?: string | null;
  /** The bold "3 of 12 added" line. Omitted when there is nothing counted. */
  count?: CartRunCount | null;
  /** Replaces the quiet line, in green with a tick, once the run has finished. */
  doneText?: string | null;
  /** A second, quieter line. Used to say "still working" when a run stalls. */
  note?: string | null;
}

export default function CartRunAnimation({ progress, label, title, subtitle, count, doneText, note }: Props) {
  const indeterminate = progress == null;
  const pct = indeterminate ? 0 : Math.max(0, Math.min(1, progress));
  const target = indeterminate ? 0 : Math.round(pct * LAST);

  // The bag fills THROUGH the intermediate frames rather than jumping. An item
  // landing should read as the bag getting fuller, and a cut does not.
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (frame === target) return;
    const step = setTimeout(() => setFrame((f) => (f < target ? f + 1 : f - 1)), FRAME_STEP_MS);
    return () => clearTimeout(step);
  }, [frame, target]);

  // A slow idle float, so a bag waiting on the login check is not a still image.
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
  const bobY = bob.interpolate({ inputRange: [0, 1], outputRange: [0, -4] });

  // A hop each time a frame lands, and a pop when the bag is full: the video's
  // beat. Only on the way UP: a bag does not celebrate getting emptier.
  const hop = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(1)).current;
  const lastFrameRef = useRef(frame);
  useEffect(() => {
    const rose = frame > lastFrameRef.current;
    lastFrameRef.current = frame;
    if (!rose) return;
    Animated.sequence([
      Animated.timing(hop, { toValue: -8, duration: 70, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(hop, { toValue: 0, duration: 90, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]).start();
    if (frame === LAST) {
      Animated.sequence([
        Animated.timing(pop, { toValue: 1.06, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pop, { toValue: 1, duration: 300, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]).start();
    }
  }, [frame, hop, pop]);
  const lift = Animated.add(bobY, hop);

  // The bar glides to the progress rather than snapping, so a burst of writes
  // reads as the bar filling, not jumping.
  const bar = useRef(new Animated.Value(pct)).current;
  useEffect(() => {
    Animated.timing(bar, { toValue: pct, duration: 300, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
  }, [pct, bar]);
  const barW = bar.interpolate({ inputRange: [0, 1], outputRange: [0, BAR_W] });

  const col = frame % COLS;
  const row = Math.floor(frame / COLS);
  const finished = !!doneText && !indeterminate && pct >= 1;

  return (
    <View style={styles.wrap} testID="cart-run-animation">
      {/* No default heading. "Filling your cart" was shown for the whole run
          including the half of it that is not filling anything: searching,
          checking the login, choosing products. A caller with something true
          to say passes it. */}
      {!!title && <Text style={styles.title} testID="cart-run-title">{title}</Text>}
      {!!subtitle && <Text style={styles.subtitle} numberOfLines={1} testID="cart-run-subtitle">{subtitle}</Text>}

      <Animated.View style={[styles.stage, { transform: [{ translateY: lift }, { scale: pop }] }]}>
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

      {!!count && count.total > 0 && (
        <Text style={styles.count} testID="cart-run-count">
          {Math.min(count.done, count.total)} of {count.total} {count.verb}
        </Text>
      )}

      {!indeterminate && (
        <View style={styles.track} testID="cart-run-bar">
          <Animated.View style={[styles.fill, { width: barW }]} />
        </View>
      )}

      {finished ? (
        <View style={styles.doneRow} testID="cart-run-done">
          <Ionicons name="checkmark" size={16} color={Colors.success} />
          <Text style={styles.doneText}>{doneText}</Text>
        </View>
      ) : (
        !!label && <Text style={styles.label} numberOfLines={1} testID="cart-run-label">{label}</Text>
      )}
      {!!note && <Text style={styles.note} testID="cart-run-note">{note}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24,
    backgroundColor: Colors.surfaceRaised,
  },
  title: { fontSize: 20, fontFamily: 'Inter_700Bold', color: Colors.text1, textAlign: 'center', letterSpacing: -0.2 },
  subtitle: { marginTop: 4, fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text2, textAlign: 'center' },
  stage: { marginTop: 20, width: DISPLAY_W, height: DISPLAY_H, alignItems: 'center', justifyContent: 'center' },
  window: { width: DISPLAY_W, height: DISPLAY_H, overflow: 'hidden' },
  count: {
    marginTop: 18, fontSize: 18, fontFamily: 'Inter_700Bold', color: Colors.text1,
    fontVariant: ['tabular-nums'],
  },
  track: { marginTop: 12, width: BAR_W, height: 8, borderRadius: 4, backgroundColor: Colors.surface, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4, backgroundColor: Colors.brand },
  label: { marginTop: 12, fontSize: 13, color: Colors.text2, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  doneRow: { marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
  doneText: { fontSize: 14, fontFamily: 'Inter_700Bold', color: Colors.success },
  note: { marginTop: 8, fontSize: 12, color: Colors.text3, opacity: 0.8, fontFamily: 'Inter_400Regular', textAlign: 'center' },
});
