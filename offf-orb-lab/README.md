# OFFF Orb Lab

One screen. One orb. Six dials.

A native iPhone prototype of the React Bits *Fluid Glass* sphere, rebuilt from
scratch with React Native Skia — no WebView, no embedded website, no images.
The orb is a single SkSL fragment shader: a procedural studio backdrop, a
ball-lens inversion of that backdrop, per-channel dispersion, Beer–Lambert
absorption and a very slow domain-warped fluid riding on the surface normal.

Drag it with one finger. It follows with elastic lag, smears slightly along
its direction of travel, keeps a little momentum when you let go, and springs
back to the middle.

---

## Open it on your iPhone

You need a computer (Mac or Windows) and your phone on the **same Wi-Fi**.

### 1. On your iPhone

Install **Expo Go** from the App Store. That's the whole phone side.

### 2. On your computer, once

Install **Node.js** — go to <https://nodejs.org>, download the big green
"LTS" button, open the file, click through the installer.

### 3. Open a terminal

- **Mac:** press `Cmd + Space`, type `Terminal`, press Enter.
- **Windows:** press the Windows key, type `PowerShell`, press Enter.

### 4. Copy-paste these three lines, one at a time

Replace the first line's path with wherever you put this folder — or just
type `cd ` (with the space) and drag the `offf-orb-lab` folder onto the
terminal window, then press Enter.

```
cd path/to/offf-orb-lab
npm install
npx expo start
```

`npm install` takes a couple of minutes the first time. You only ever do it
once.

### 5. Scan the QR code

`npx expo start` prints a QR code in the terminal. Point your iPhone camera
at it and tap the banner that appears. Expo Go opens and the orb loads.

To stop, press `Ctrl + C` in the terminal. To start again another day, just
`cd` into the folder and run `npx expo start`.

---

## Using it

- **Drag the orb** anywhere on the stage with one finger.
- **Six sliders** underneath. Drag or tap anywhere along a line.
- **RESET** in the top right puts every slider back to the starting look.

| Control | What it does |
| --- | --- |
| Refraction | How hard the glass bends the world behind it. 0 is almost a window, 100 is a dense lens. |
| Chromatic aberration | Splits red and blue through the glass. Rainbow edges live here. |
| Distortion | Amplitude of the fluid moving through the glass. High values wobble the silhouette too. |
| Movement speed | How fast the interior flows. Leave it low — the look depends on it being almost imperceptible. |
| Transparency | Clear optical glass at 100, denser and more tinted toward 0. |
| Glass thickness | Thin shell at 0 (bends only at the rim), solid glass ball at 100 (inverts the whole scene). |

Everything is live — no reload, no code.

---

## If something goes wrong

- **The QR code won't connect.** Your Wi-Fi is blocking it. Stop with
  `Ctrl + C` and run `npx expo start --tunnel` instead. Slower, works
  anywhere.
- **`npx: command not found`.** Node.js didn't install, or the terminal was
  open before you installed it. Close the terminal, open a new one, try again.
- **Expo Go says the project needs a newer version.** Update Expo Go from the
  App Store.
- **The screen is black.** Shake the phone, tap Reload.

---

## What's in here

```
App.js             screen layout, the six shared values, reset
src/Orb.js         Skia canvas, drag gesture, spring physics, uniforms
src/orbShader.js   the SkSL glass shader — the whole look lives here
src/Slider.js      the minimal slider
src/theme.js       colours
```

## Notes on performance

The gesture, the spring integration and every shader uniform run on the UI
thread through Reanimated worklets — dragging never crosses to JavaScript, so
the orb holds display rate (including 120 Hz ProMotion). Moving a slider
updates a shared value directly; the only React re-render is the small number
next to its label. The canvas covers the stage area only, not the full screen,
and the shader returns the backdrop early for every pixel outside the orb.
