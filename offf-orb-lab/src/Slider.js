import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, runOnJS } from 'react-native-reanimated';
import { C } from './theme';

const THUMB = 18;

/**
 * Minimal art-direction slider. The value lives in a shared value so dragging
 * it never re-renders the Skia canvas — only the little number updates, and
 * only when the rounded percentage actually changes.
 */
export default function Slider({ label, value }) {
  const [pct, setPct] = useState(() => Math.round(value.value * 100));
  const width = useSharedValue(1);
  const lastPct = useSharedValue(-1);

  const apply = (x) => {
    'worklet';
    const w = Math.max(width.value, 1);
    const v = Math.min(Math.max(x / w, 0), 1);
    value.value = v;
    const p = Math.round(v * 100);
    if (p !== lastPct.value) {
      lastPct.value = p;
      runOnJS(setPct)(p);
    }
  };

  const pan = Gesture.Pan()
    .minDistance(0)
    .onBegin((e) => apply(e.x))
    .onUpdate((e) => apply(e.x));

  const fillStyle = useAnimatedStyle(() => ({
    width: THUMB / 2 + value.value * Math.max(width.value - THUMB, 0),
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: value.value * Math.max(width.value - THUMB, 0) }],
  }));

  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.value}>{String(pct).padStart(3, '0')}</Text>
      </View>
      <GestureDetector gesture={pan}>
        <View
          style={styles.hit}
          onLayout={(e) => {
            width.value = e.nativeEvent.layout.width;
          }}
        >
          <View style={styles.track} />
          <Animated.View style={[styles.fill, fillStyle]} />
          <Animated.View style={[styles.thumb, thumbStyle]} />
        </View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { marginBottom: 2 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  label: { color: C.muted, fontSize: 10.5, letterSpacing: 1.6, textTransform: 'uppercase' },
  value: {
    color: C.text,
    fontSize: 10.5,
    letterSpacing: 1.2,
    fontVariant: ['tabular-nums'],
  },
  hit: { height: 30, justifyContent: 'center' },
  track: { height: 1, backgroundColor: C.track, borderRadius: 1 },
  fill: {
    position: 'absolute',
    height: 1,
    backgroundColor: C.fill,
    borderRadius: 1,
  },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: C.thumb,
  },
});
