import React, { useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Canvas, Fill, Shader, Skia } from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
} from 'react-native-reanimated';
import { ORB_SHADER } from './orbShader';

const clamp = (v, lo, hi) => {
  'worklet';
  return Math.min(Math.max(v, lo), hi);
};

// Spring constants. zeta lands around 0.8 in both states: the orb catches up
// without snapping, and returns home with one almost invisible overshoot.
const HELD_K = 118;
const HELD_C = 17;
const HOME_K = 26;
const HOME_C = 8.2;
const VEL_REF = 1100; // px/s that counts as "full" velocity for the shader

export default function Orb({ params }) {
  const [size, setSize] = useState({ w: 0, h: 0 });

  const effect = useMemo(() => {
    const e = Skia.RuntimeEffect.Make(ORB_SHADER);
    if (!e) {
      throw new Error('OFFF Orb Lab: the orb shader failed to compile.');
    }
    return e;
  }, []);

  // Everything below lives on the UI thread: gesture, physics and uniforms
  // never touch JS, so dragging stays at display rate.
  const t = useSharedValue(0); // interior clock, seconds
  const ox = useSharedValue(0); // orb offset from rest
  const oy = useSharedValue(0);
  const vx = useSharedValue(0); // orb velocity, px/s
  const vy = useSharedValue(0);
  const tx = useSharedValue(0); // where the finger wants it
  const ty = useSharedValue(0);
  const held = useSharedValue(0);
  const svx = useSharedValue(0); // smoothed velocity handed to the shader
  const svy = useSharedValue(0);

  const ready = size.w > 0 && size.h > 0;
  const radius = ready ? Math.min(size.w, size.h) * 0.34 : 1;
  const cx = size.w / 2;
  const cy = size.h / 2;
  const maxX = Math.max(size.w / 2 - radius * 0.55, 0);
  const maxY = Math.max(size.h / 2 - radius * 0.55, 0);

  useFrameCallback((info) => {
    'worklet';
    const dt = Math.min(Math.max(info.timeSincePreviousFrame ?? 16.7, 1), 34) / 1000;

    // Integrated rather than sampled, so moving the speed slider bends the
    // pace of the fluid instead of jumping it.
    t.value += dt * (0.04 + params.speed.value * 1.1);

    const holding = held.value === 1;
    const k = holding ? HELD_K : HOME_K;
    const c = holding ? HELD_C : HOME_C;

    vx.value += (k * (tx.value - ox.value) - c * vx.value) * dt;
    vy.value += (k * (ty.value - oy.value) - c * vy.value) * dt;
    ox.value += vx.value * dt;
    oy.value += vy.value * dt;

    const s = Math.min(1, dt * 9);
    svx.value += (clamp(vx.value / VEL_REF, -1, 1) - svx.value) * s;
    svy.value += (clamp(vy.value / VEL_REF, -1, 1) - svy.value) * s;
  });

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .maxPointers(1)
        .minDistance(0)
        .onBegin((e) => {
          const dx = e.x - (cx + ox.value);
          const dy = e.y - (cy + oy.value);
          const grab = radius * 1.25;
          held.value = dx * dx + dy * dy <= grab * grab ? 1 : 0;
          if (held.value === 1) {
            // start the target where the orb actually is, so catching it
            // mid-flight never snaps
            tx.value = ox.value;
            ty.value = oy.value;
          }
        })
        .onChange((e) => {
          if (held.value !== 1) {
            return;
          }
          tx.value = clamp(tx.value + e.changeX, -maxX, maxX);
          ty.value = clamp(ty.value + e.changeY, -maxY, maxY);
        })
        .onFinalize((e) => {
          if (held.value !== 1) {
            return;
          }
          held.value = 0;
          tx.value = 0;
          ty.value = 0;
          // keep a little of the throw, not all of it
          vx.value = clamp(vx.value * 0.6 + (e.velocityX ?? 0) * 0.14, -1400, 1400);
          vy.value = clamp(vy.value * 0.6 + (e.velocityY ?? 0) * 0.14, -1400, 1400);
        }),
    [cx, cy, radius, maxX, maxY]
  );

  const uniforms = useDerivedValue(
    () => ({
      u_res: [Math.max(size.w, 1), Math.max(size.h, 1)],
      u_center: [cx + ox.value, cy + oy.value],
      u_radius: radius,
      u_time: t.value,
      u_refraction: params.refraction.value,
      u_aberration: params.aberration.value,
      u_distortion: params.distortion.value,
      u_transparency: params.transparency.value,
      u_thickness: params.thickness.value,
      u_vel: [svx.value, svy.value],
    }),
    [size.w, size.h, cx, cy, radius]
  );

  return (
    <GestureDetector gesture={pan}>
      <View
        style={styles.stage}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setSize((prev) =>
            prev.w === width && prev.h === height ? prev : { w: width, h: height }
          );
        }}
      >
        {ready ? (
          <Canvas style={StyleSheet.absoluteFill}>
            <Fill>
              <Shader source={effect} uniforms={uniforms} />
            </Fill>
          </Canvas>
        ) : null}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, overflow: 'hidden' },
});
