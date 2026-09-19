import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import Orb from './src/Orb';
import Slider from './src/Slider';
import { C } from './src/theme';

const DEFAULTS = {
  refraction: 0.58,
  aberration: 0.4,
  distortion: 0.34,
  speed: 0.3,
  transparency: 0.7,
  thickness: 0.55,
};

const CONTROLS = [
  ['Refraction', 'refraction'],
  ['Chromatic aberration', 'aberration'],
  ['Distortion', 'distortion'],
  ['Movement speed', 'speed'],
  ['Transparency', 'transparency'],
  ['Glass thickness', 'thickness'],
];

function Lab() {
  const insets = useSafeAreaInsets();
  const [generation, setGeneration] = useState(0);

  const params = {
    refraction: useSharedValue(DEFAULTS.refraction),
    aberration: useSharedValue(DEFAULTS.aberration),
    distortion: useSharedValue(DEFAULTS.distortion),
    speed: useSharedValue(DEFAULTS.speed),
    transparency: useSharedValue(DEFAULTS.transparency),
    thickness: useSharedValue(DEFAULTS.thickness),
  };

  const reset = useCallback(() => {
    Object.keys(DEFAULTS).forEach((key) => {
      params[key].value = DEFAULTS[key];
    });
    // remount the rows so their read-outs follow the shared values back
    setGeneration((g) => g + 1);
  }, [params]);

  return (
    <View style={[styles.root, { paddingTop: insets.top + 10 }]}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <View>
          <Text style={styles.title}>OFFF ORB LAB</Text>
          <Text style={styles.subtitle}>Drag the orb · tune below</Text>
        </View>
        <Pressable onPress={reset} hitSlop={12} style={styles.reset}>
          <Text style={styles.resetText}>RESET</Text>
        </Pressable>
      </View>

      <Orb params={params} />

      <View style={[styles.controls, { paddingBottom: insets.bottom + 14 }]}>
        {CONTROLS.map(([label, key]) => (
          <Slider key={`${key}-${generation}`} label={label} value={params[key]} />
        ))}
      </View>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={styles.flex}>
        <Lab />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  root: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingBottom: 12,
  },
  title: { color: C.text, fontSize: 13, letterSpacing: 3.4, fontWeight: '600' },
  subtitle: { color: C.dim, fontSize: 10, letterSpacing: 1.4, marginTop: 5 },
  reset: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.hairline,
    borderRadius: 3,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  resetText: { color: C.muted, fontSize: 9, letterSpacing: 1.8 },
  controls: {
    paddingHorizontal: 22,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hairline,
    backgroundColor: C.panel,
  },
});
