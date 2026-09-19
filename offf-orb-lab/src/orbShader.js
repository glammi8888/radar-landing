/**
 * OFFF Orb Lab — glass orb runtime shader (SkSL).
 *
 * The orb is shaded as a solid piece of optical glass sitting in front of a
 * procedural studio backdrop. Everything you see inside it is that backdrop,
 * bent: a ball-lens inversion for the body, a per-pixel refraction for the
 * fluid surface, and a per-channel split of the total bend for dispersion.
 * Nothing is emissive — no glow, no gradient fill.
 */
export const ORB_SHADER = `
uniform float2 u_res;          // canvas size, px
uniform float2 u_center;       // orb centre, px
uniform float  u_radius;       // orb radius, px
uniform float  u_time;         // seconds, already scaled by the speed control
uniform float  u_refraction;   // 0..1
uniform float  u_aberration;   // 0..1
uniform float  u_distortion;   // 0..1
uniform float  u_transparency; // 0..1
uniform float  u_thickness;    // 0..1
uniform float2 u_vel;          // drag velocity, -1..1 per axis

const float TAU = 6.28318530718;

float hash21(float2 p) {
  p = fract(p * float2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + float2(1.0, 0.0));
  float c = hash21(i + float2(0.0, 1.0));
  float d = hash21(i + float2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// 3 octaves is all the orb needs; it keeps the fill rate cheap on device.
float fbm(float2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + float2(11.3, 7.7);
    a *= 0.5;
  }
  return v / 0.875;
}

// Rounded-box field, used to lay bold shapes into the backdrop.
float boxField(float2 uv, float2 c, float2 h, float soft) {
  float2 d = abs(uv - c) - h;
  float dist = length(max(d, float2(0.0))) + min(max(d.x, d.y), 0.0);
  return 1.0 - smoothstep(0.0, soft, dist);
}

// The world behind the glass. Procedural, high contrast, and deliberately
// graphic — refraction only reads as optics when there is real structure
// behind it to bend. This is the thing the orb is a lens onto.
float3 backdrop(float2 p) {
  float2 uv = p / u_res;
  float2 cuv = clamp(uv, -0.6, 1.6);

  float3 col = mix(float3(0.055, 0.060, 0.070),
                   float3(0.105, 0.112, 0.130),
                   clamp(cuv.y, 0.0, 1.0));

  // key pool of light, upper left
  float k = 1.0 - clamp(length((cuv - float2(0.16, 0.06)) * float2(1.0, 1.2)), 0.0, 1.0);
  col += float3(0.34, 0.37, 0.44) * pow(k, 2.0) * 0.85;

  // cool fill, lower right
  float f2 = 1.0 - clamp(length((cuv - float2(1.02, 0.98)) * float2(1.0, 1.1)) * 0.9, 0.0, 1.0);
  col += float3(0.10, 0.16, 0.32) * pow(f2, 2.2);

  // warm accent, lower left
  float f3 = 1.0 - clamp(length(cuv - float2(-0.02, 1.04)) * 1.25, 0.0, 1.0);
  col += float3(0.34, 0.19, 0.07) * pow(f3, 2.8);

  // bold graphic bars — the high-contrast edges the glass feeds on
  col += float3(0.34, 0.36, 0.42) * boxField(cuv, float2(0.32, 0.17), float2(0.28, 0.010), 0.014);
  col += float3(0.17, 0.19, 0.24) * boxField(cuv, float2(0.62, 0.30), float2(0.20, 0.006), 0.010);
  col += float3(0.12, 0.19, 0.34) * boxField(cuv, float2(0.44, 0.83), float2(0.34, 0.012), 0.016);
  col += float3(0.30, 0.18, 0.08) * boxField(cuv, float2(0.16, 0.62), float2(0.009, 0.22), 0.012);

  // a thin ring, for something curved to bend
  float rr = abs(length((cuv - float2(0.74, 0.64)) * float2(1.0, 1.0)) - 0.175);
  col += float3(0.20, 0.22, 0.28) * (1.0 - smoothstep(0.0, 0.007, rr));

  // measured grid
  float2 g1 = abs(fract(p / 46.0 + 0.5) - 0.5) * 46.0;
  col += float3(0.060, 0.065, 0.078) * (1.0 - smoothstep(0.5, 1.9, min(g1.x, g1.y)));

  float2 g2 = abs(fract(p / 184.0 + 0.5) - 0.5) * 184.0;
  col += float3(0.10, 0.11, 0.135) * (1.0 - smoothstep(0.7, 2.6, min(g2.x, g2.y)));

  col *= 1.0 - 0.45 * pow(clamp(length((cuv - 0.5) * float2(1.05, 0.95)) * 1.25, 0.0, 1.0), 2.0);
  col += (hash21(p * 0.73) - 0.5) * 0.012;
  return col;
}

// Studio environment sampled by the reflection vector: dark floor, soft
// overhead strip, cool sky. Keeps the rim reading as polished glass.
float3 envColor(float3 d) {
  float up = clamp(-d.y * 0.5 + 0.5, 0.0, 1.0);
  float3 c = mix(float3(0.018, 0.021, 0.029),
                 float3(0.28, 0.31, 0.38),
                 smoothstep(0.30, 1.0, up));
  c += float3(0.85, 0.88, 0.98) * smoothstep(0.82, 0.998, up) * 0.60;
  c += float3(0.11, 0.09, 0.12) * smoothstep(0.28, 0.0, up);
  return c;
}

float3 refractDir(float3 I, float3 N, float eta) {
  float ci = -dot(N, I);
  float k = 1.0 - eta * eta * (1.0 - ci * ci);
  if (k < 0.0) {
    return float3(0.0);
  }
  return eta * I + (eta * ci - sqrt(k)) * N;
}

half4 main(float2 fragCoord) {
  float2 p = fragCoord;
  float R = max(u_radius, 1.0);
  float2 rel = p - u_center;

  // --- inertial shear: stretch along travel, squash across it -------------
  float vlen = length(u_vel);
  float vmag = min(vlen, 1.0);
  float2 vdir = vlen > 0.0008 ? u_vel / vlen : float2(1.0, 0.0);
  float2 vperp = float2(-vdir.y, vdir.x);
  float st = vmag * 0.095;
  float2 lq = float2(dot(rel, vdir), dot(rel, vperp)) / R;
  lq.x /= (1.0 + st);
  lq.y /= (1.0 - st * 0.55);
  float2 q = vdir * lq.x + vperp * lq.y;

  float3 bg = backdrop(p);

  // Contact shadow, lagging behind the motion so the orb feels weighted.
  float2 sp = (p - (u_center + float2(R * 0.12, R * 0.66) + u_vel * R * 0.12))
              / float2(R * 1.04, R * 0.90);
  float shadow = (1.0 - smoothstep(0.25, 1.35, length(sp))) * 0.72;
  bg *= 1.0 - shadow * 0.85;

  float t = u_time;
  float r0 = length(q);

  // Organic silhouette breathing — small enough that it stays a true sphere.
  float wob = (fbm(q * 1.55 + float2(t * 0.075, -t * 0.061)) - 0.5) * 0.055 * u_distortion;
  float r = r0 * (1.0 - wob);

  float aa = 1.2 / R;
  if (r > 1.0 + aa) {
    return half4(half3(bg), 1.0);
  }

  float z = sqrt(max(1.0 - min(r * r, 1.0), 0.0));
  float3 N = float3(q, z);

  // --- fluid interior: domain-warped noise, very slow --------------------
  float2 w1 = float2(fbm(q * 1.7 + float2(0.0, t * 0.105)),
                     fbm(q * 1.7 + float2(4.3, -t * 0.088))) - 0.5;
  float2 w2 = float2(fbm(q * 2.9 + w1 * 2.1 + float2(t * 0.068, 2.1)),
                     fbm(q * 2.9 + w1 * 2.1 + float2(-3.1, t * 0.057))) - 0.5;
  float3 flow = float3(w2, (w1.x + w2.y) * 0.5) * (0.18 + 0.95 * u_distortion);
  flow *= 0.35 + 0.65 * (1.0 - r * r);
  N = normalize(N + flow * (0.5 + 0.55 * z));

  float2 dir = r > 0.0001 ? q / r : float2(0.0, 0.0);

  // --- ball-lens body: the world behind, inverted and compressed toward
  //     the rim. Thickness decides shell-like vs. solid-glass behaviour.
  float fr = tan(min(r, 0.985) * 1.22) / tan(1.22);
  float lensAmt = mix(0.34, 1.25, u_thickness) * mix(0.45, 1.30, u_refraction);
  float2 lensPt = u_center - dir * (R * 2.05 * fr * lensAmt);

  // --- surface refraction: the fluid skin riding on top of the lens ------
  float3 I = float3(0.0, 0.0, -1.0);
  float ior = mix(1.05, 1.80, u_refraction);
  float3 T = refractDir(I, N, 1.0 / ior);
  float2 surfOff = T.xy * (R * mix(0.16, 0.85, u_thickness) / max(0.35, abs(T.z)))
                 * mix(0.35, 1.40, u_refraction);

  // Total bend, split per channel. Dispersion is scaled by how hard the
  // glass is bending here, so the rainbow lives on the rim, not everywhere.
  float2 bend = (lensPt - p) + surfOff;
  float dsp = u_aberration * 0.055 * (0.10 + 0.90 * smoothstep(0.15, 1.0, r));
  float3 col = float3(
    backdrop(p + bend * (1.0 - dsp)).r,
    backdrop(p + bend).g,
    backdrop(p + bend * (1.0 + dsp)).b
  );

  // Light that bounces off the inner back surface before leaving: the faint
  // second image that gives real glass its depth.
  float3 tir = backdrop(p - bend * 1.35);
  col += tir * (0.09 + 0.16 * u_thickness) * (0.55 + 0.45 * (1.0 - u_transparency));

  // --- Beer-Lambert absorption through the glass body --------------------
  float path = (0.25 + 1.20 * u_thickness) * (0.30 + 1.30 * z);
  col *= exp(-float3(0.30, 0.18, 0.13) * path * (1.05 - 0.85 * u_transparency));

  // --- internal structure: slow density variation, not added light -------
  float n = fbm(q * 2.25 + w1 * 1.35 + float2(t * 0.049, -t * 0.041));
  float core = smoothstep(1.0, 0.20, r);
  col *= 1.0 + (n - 0.5) * (0.20 + 0.45 * (1.0 - u_transparency)) * core;

  float ridge = 1.0 - abs(n * 2.0 - 1.0);
  float wisp = pow(clamp(ridge, 0.0, 1.0), 8.0);
  col += float3(0.55, 0.66, 0.90) * wisp * core * 0.07 * (0.3 + 0.7 * u_thickness);

  // focused caustic on the far side of the body
  float3 L = normalize(float3(-0.45, -0.62, 0.64));
  float caus = pow(clamp(dot(N, -L) * 0.5 + 0.5, 0.0, 1.0), 10.0);
  col += float3(0.82, 0.86, 1.0) * caus * 0.14 * (0.4 + 0.6 * u_refraction);

  // --- fresnel reflection of the studio ----------------------------------
  // The silhouette normal stays clean so the rim and the key highlight read
  // as polished glass; only the body normal carries the fluid.
  float3 Nb = normalize(float3(q, max(z, 0.02)));
  float3 Ns = normalize(mix(Nb, N, 0.30));
  float nz = clamp(Nb.z, 0.0, 1.0);
  float f0 = 0.05;
  float fres = f0 + (1.0 - f0) * pow(1.0 - nz, 5.0);
  float3 Rv = I - 2.0 * dot(Ns, I) * Ns;
  col = mix(col, envColor(Rv), clamp(fres * (1.20 - 0.40 * u_transparency), 0.0, 1.0));

  // --- dispersion fringe, rim only ---------------------------------------
  float band = smoothstep(0.72, 1.0, r);
  float phase = r * 2.6 - 1.4 * nz + 0.08 * t + (n - 0.5) * 0.6;
  float3 irid = 0.5 + 0.5 * cos(TAU * (phase + float3(0.0, 0.333, 0.667)));
  col += (irid - 0.4) * band * u_aberration * (0.22 + 0.45 * fres);

  // --- speculars: one hard key, one broad softbox ------------------------
  float3 V = float3(0.0, 0.0, 1.0);
  float3 H1 = normalize(normalize(float3(-0.60, -0.68, 0.62)) + V);
  float3 H2 = normalize(normalize(float3(0.78, -0.26, 0.52)) + V);
  col += float3(1.0, 0.99, 0.96) * pow(clamp(dot(Ns, H1), 0.0, 1.0), 420.0) * 1.45;
  col += float3(0.60, 0.66, 0.80) * pow(clamp(Nb.x * 0.62 + (-Nb.y) * 0.26 + Nb.z * 0.74, 0.0, 1.0), 14.0) * 0.10;
  col += float3(0.55, 0.62, 0.78) * pow(clamp(dot(Ns, H2), 0.0, 1.0), 30.0) * 0.10;

  // --- edge: thin dark contact line, then the hot ring just inside it ----
  col *= 1.0 - smoothstep(0.93, 1.0, r) * 0.45 * (0.35 + 0.65 * u_thickness);
  float ring = exp(-pow((r - 0.965) / 0.020, 2.0));
  col += float3(0.88, 0.92, 1.0) * ring * (0.30 + 0.55 * fres);

  col *= 1.08; // transmission gain, keeps the body from going muddy

  float mask = 1.0 - smoothstep(1.0 - aa, 1.0, r);
  float3 outc = clamp(mix(bg, col, mask), 0.0, 1.0);
  return half4(half3(outc), 1.0);
}
`;
