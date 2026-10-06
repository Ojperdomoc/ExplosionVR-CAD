/**
 * scratch.js
 * ---------------------------------------------------------------------------
 * Pre-allocated temporaries for the XR frame loop.
 *
 * WebXR renders at 72-120 Hz. A single `new THREE.Vector3()` per joint per hand
 * per frame is ~2 * 25 * 90 = 4500 allocations/second, which shows up as GC
 * hitches (dropped frames in a headset are felt as judder). Everything that runs
 * per frame reuses the objects below.
 *
 * RULE: never store a reference to a scratch object across frames. Copy out of
 * it (`.copy()` / `.set()`) if the value must survive.
 * ---------------------------------------------------------------------------
 */

import { Matrix4, Quaternion, Vector2, Vector3 } from 'three';

export const v1 = new Vector3();
export const v2 = new Vector3();
export const v3 = new Vector3();
export const v4 = new Vector3();
export const v5 = new Vector3();

export const q1 = new Quaternion();
export const q2 = new Quaternion();

export const m1 = new Matrix4();
export const m2 = new Matrix4();
export const m3 = new Matrix4();

export const uv1 = new Vector2();

/** Colour helpers avoid re-allocating THREE.Color instances in hot paths. */
import { Color } from 'three';
export const c1 = new Color();
export const c2 = new Color();
