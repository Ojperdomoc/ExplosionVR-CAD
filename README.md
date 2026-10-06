# HandXR Parts Explorer

A WebXR hand-tracked interface for exploring mechanical machine parts in 3D,
built on **Three.js** (`r186`, vendored — no CDN) and the **WebXR Hand Input**
module. Two complete machines are included (a hydraulic piston assembly and a
planetary gearbox), each split into selectable sub-components with hover
highlighting, pinch-to-grab, and a two-hand exploded-view gesture.

Three hand inputs feed one pipeline:

1. **XRHand** — real hand tracking inside a WebXR runtime (headset).
2. **Camera** — on-device webcam hand tracking (MediaPipe HandLandmarker,
   vendored) for desktops, because a plain browser is *not* an XR runtime and a
   webcam can never appear as an `XRHand`.
3. **Puppet** — a mouse-driven synthetic hand so everything is testable with no
   camera and no headset.

---

## Live demo (GitHub Pages)

The app deploys straight from this repository to GitHub Pages:

**https://ojperdomoc.github.io/ExplosionVR-CAD/**

Pages is HTTPS by default, which is exactly what WebXR, webcam access, and
`SharedArrayBuffer`-class APIs require — the headset and camera features work
from the hosted URL just as they do locally.

Deployment details are in [Deployment](#deployment) below.

---

## Quick start

```bash
npm start            # static server on :8123
# open http://localhost:8123/
```

No build step, no dependencies at runtime — the engine is vendored under
`vendor/three/` and everything is native ES modules behind an import map.

## Deployment

The repo is a fully static site (`index.html` at the root, all paths
relative), so it deploys to GitHub Pages without any build step:

- **`.github/workflows/pages.yml`** builds a Pages artifact from the checkout
  and deploys it on every push to `main` (or manually via *Actions → Deploy to
  GitHub Pages → Run workflow*). The workflow enables the Pages site
  automatically (source: *GitHub Actions*) on its first run — no settings
  toggling needed. If you ever want to point Pages at the branch instead, use
  *Settings → Pages → Source: GitHub Actions*.
- **`.nojekyll`** marks the site as plain files so Pages never runs a Jekyll
  build over the ~35 MB of vendored wasm/model binaries (that legacy path is
  what usually makes "Pages is enabled but the site is blank/late").

Requirements on the GitHub side:

- On a **free** account, Pages only serves **public** repositories — make the
  repo public (or upgrade to a paid plan for private-repo Pages).
- The site lands at `https://<user>.github.io/<repo>/`; every asset reference
  in the app is relative, so the sub-path needs no configuration.

Verify:

```bash
npm run test:unit     # headless logic tests (no GPU)
npm run test:browser  # end-to-end in headless Chromium + SwiftShader
```

The browser suite drives the *real* interaction path (pointer → puppet hand →
pinch → grab/explode) and asserts on scene state.

---

## What it does

| Feature | Where |
|---|---|
| IBL environment + key/rim/fill lights, clean shadows | `core/LightingRig.js` |
| Dark grid floor, shadow catcher, grounding plinth | `core/Stage.js` |
| 8-part piston + 6-part gearbox, per-part metadata | `machine/pistonAssembly.js`, `machine/gearboxAssembly.js` |
| Webcam hand tracking (MediaPipe, offline) | `interaction/CameraHandProvider.js` |
| Hand joints + bones (2 draw calls/hand) | `ui/HandRenderer.js` |
| Proximity hover (emissive + edge overlay) | `interaction/ProximitySensor.js`, `machine/MachinePart.js` |
| Pinch grab & move/rotate, two-hand relative pose | `interaction/GrabController.js` |
| Two-hand pull-apart exploded view | `interaction/HandInteractionController.js`, `machine/ExplodeController.js` |
| World-space spec panel (canvas texture) | `ui/PartTooltip.js` |
| In-world tool menu (works in VR, no DOM) | `ui/SpatialMenu.js` |
| Desktop OrbitControls + mouse "puppet hand" | `core/SceneManager.js`, `interaction/SimHandProvider.js` |

---

## The interaction model

Everything funnels through one `HandState` per hand. Two *providers* fill it:

- `XRHandProvider` — real `XRHand` joints (reads `joint.matrixWorld`, which for
  a root-mounted hand is the pose in the XR reference space).
- `CameraHandProvider` — webcam landmarks (21 MediaPipe points) expanded to the
  25 XR joints, wrist placed in the view frustum by a monocular depth estimate,
  pinch taken from the metric thumb/index distance. Press **Camera** (or `C`).
- `SimHandProvider` — a desktop puppet that synthesises the same 25 joint poses
  from a pointer raycast, so a laptop exercises the identical gesture code.

Only one provider owns a hand at a time; `HandState.source` records which.

### Gestures

- **Hover** — index fingertip within reach of a component. Broad phase is a
  bounding-sphere test; a narrow-phase raycast then picks the surface actually
  under the finger, which is what lets you hover a small valve without it being
  swallowed by the housing's huge bounding sphere (and why an enclosed part
  can't be hovered until you explode the machine).
- **Grab** — pinch (thumb + index) while hovering. One hand = rigid 6-DOF
  (`P' = H·H₀⁻¹·P₀`). A second pinch on the *same* part switches to a
  relative-pose solver (rotate about the axis between the hands).
- **Explode** — pinch two *different* components and pull apart. Hand span
  beyond the latched rest distance drives the explosion continuously; release
  snaps to the nearer end.
- **Tap** — pinch over a spatial-menu button.

Pinch uses hysteresis (engage 21 mm / release 33 mm) so tracking jitter never
makes a held part stutter open/closed.

---

## Performance notes

- **Hand = 2 instanced draw calls** (joints + bones), compacted per frame.
- **Shadows are manual**: `shadowMap.autoUpdate = false`; the map re-renders
  only when a part actually moves.
- **Canvas textures repaint only on content change** (tooltip / menu).
- **No per-frame allocations** in hot paths (shared `utils/scratch.js` temps).
- **Adaptive render scale** trims pixel ratio when the frame time runs away.
- Hover is a sphere test, not a full-scene raycast, per frame.

---

## Layout

```
src/
  core/        renderer, camera, XR session, lighting, stage, composition root
  machine/     assemblies, part wrapper, exploded-view controller, geometry kit
  interaction/ hand state, providers, pinch, proximity, grab, gesture orchestrator
  ui/          hand renderer, tooltip, spatial menu, DOM HUD
  utils/       math + scratch temps
tests/
  unit.test.mjs    headless logic (math, pinch, proximity, explode, grab)
  browser.test.mjs end-to-end in a real browser
```

---

## Camera tracking caveats

- Monocular video gives depth only by estimation (apparent vs metric hand
  size), so camera hands are great for hover/pinch/explode but less precise
  than XR tracking. Tune `DEFAULT_GESTURE_CONFIG` if you change hardware.
- The camera button asks for permission and loads the ~8 MB landmark model on
  first use (served locally from `vendor/mediapipe/`).

## Known limits / where to extend

- Uses `immersive-vr` + `optionalFeatures: ['hand-tracking','local-floor']`,
  falling back to `local` reference space if the runtime refuses floor.
- Controller models are not rendered; when hands are absent the app keeps the
  proximity/grab model driven by whatever joint data exists. Swap in
  `XRControllerModelFactory` if you want physical controller meshes.
- Drop a GLTF CAD export into the registry by building `MachinePart`s from its
  nodes — the interaction layer only consumes `parts: MachinePart[]`.
