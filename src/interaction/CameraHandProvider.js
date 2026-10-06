/**
 * CameraHandProvider.js
 * ---------------------------------------------------------------------------
 * Webcam hand tracking for desktop browsers.
 *
 * Why this exists at all: WebXR's `XRHand` is only produced by an XR RUNTIME
 * (Quest, Vision Pro, a PC headset bridge). A laptop webcam is NOT an XR input
 * source, so `navigator.xr` can never deliver hands from it — on a plain
 * desktop the only options were the mouse puppet or nothing. This provider
 * closes that gap with on-device vision (MediaPipe HandLandmarker), driving
 * the SAME HandState / gesture pipeline as XR and the puppet.
 *
 * Pipeline (per detected hand):
 *   1. `detectForVideo` yields 21 landmarks: normalised screen coords PLUS
 *      `worldLandmarks` — metric (metres), wrist-relative, in camera space.
 *      The metric set is what makes real pinch distances possible.
 *   2. The wrist is placed in the three.js camera's view frustum: its screen
 *      position comes from the normalised landmark, its DEPTH from comparing
 *      the hand's metric size to its apparent on-screen size (bigger on screen
 *      = closer). That is a rough but stable monocular depth estimate.
 *   3. All 25 XR joints are then `wrist + worldLandmark`, mapped from the 21
 *      MediaPipe points (metacarpals synthesised mid wrist->MCP), and pushed
 *      through the viewer camera's matrix into world space. The video is shown
 *      mirrored (selfie convention), so X is mirrored to match.
 *   4. Pinch distance = |thumbTip - indexTip| in metres, so PinchDetector's
 *      XR thresholds apply unchanged.
 *
 * Everything that does not need a camera (landmark -> joint mapping, depth
 * estimate) is exported as a pure function and unit-tested headlessly.
 * ---------------------------------------------------------------------------
 */

import { Matrix4, Quaternion, Vector3 } from 'three';

/** MediaPipe landmark index for each XR joint name (`-1` = synthesised). */
export const MP_INDEX = Object.freeze( {
	'wrist': 0,
	'thumb-metacarpal': 1,
	'thumb-phalanx-proximal': 2,
	'thumb-phalanx-distal': 3,
	'thumb-tip': 4,
	'index-finger-metacarpal': - 1,
	'index-finger-phalanx-proximal': 5,
	'index-finger-phalanx-intermediate': 6,
	'index-finger-phalanx-distal': 7,
	'index-finger-tip': 8,
	'middle-finger-metacarpal': - 1,
	'middle-finger-phalanx-proximal': 9,
	'middle-finger-phalanx-intermediate': 10,
	'middle-finger-phalanx-distal': 11,
	'middle-finger-tip': 12,
	'ring-finger-metacarpal': - 1,
	'ring-finger-phalanx-proximal': 13,
	'ring-finger-phalanx-intermediate': 14,
	'ring-finger-phalanx-distal': 15,
	'ring-finger-tip': 16,
	'pinky-finger-metacarpal': - 1,
	'pinky-finger-phalanx-proximal': 17,
	'pinky-finger-phalanx-intermediate': 18,
	'pinky-finger-phalanx-distal': 19,
	'pinky-finger-tip': 20,
} );

/** Which MCP each synthesised metacarpal hangs off. */
const METACARPAL_MCP = Object.freeze( {
	'index-finger-metacarpal': 5,
	'middle-finger-metacarpal': 9,
	'ring-finger-metacarpal': 13,
	'pinky-finger-metacarpal': 17,
} );

const _v = /* @__PURE__ */ new Vector3();
const _w = /* @__PURE__ */ new Vector3();
const _fwd = /* @__PURE__ */ new Vector3();
const _across = /* @__PURE__ */ new Vector3();
const _up = /* @__PURE__ */ new Vector3();
const _m = /* @__PURE__ */ new Matrix4();

/**
 * Pure: expand 21 metric MediaPipe landmarks into the 25 XR joints.
 *
 * @param {{x:number,y:number,z:number}[]} wl  worldLandmarks (metres).
 * @param {boolean} mirror  Flip X (selfie mirroring preserves chirality).
 * @param {Map<string,{position:Vector3}>} [out] Optional joint map to fill.
 * @returns {Map<string,Vector3>}
 */
export function mapLandmarksToJoints( wl, mirror, out = new Map() ) {

	const sx = mirror ? - 1 : 1;

	for ( const [ name, index ] of Object.entries( MP_INDEX ) ) {

		let target = out.get( name );
		if ( ! target ) {

			target = new Vector3();
			out.set( name, target );

		}

		if ( index >= 0 ) {

			const p = wl[ index ];
			target.set( p.x * sx, p.y, p.z );

		} else {

			// Metacarpal: halfway between wrist and the finger's MCP.
			const mcp = wl[ METACARPAL_MCP[ name ] ];
			const wrist = wl[ 0 ];
			target.set(
				( wrist.x + mcp.x ) * 0.5 * sx,
				( wrist.y + mcp.y ) * 0.5,
				( wrist.z + mcp.z ) * 0.5
			);

		}

	}

	return out;

}

/**
 * Pure: monocular depth estimate from apparent vs metric hand size.
 *
 * @param {{x:number,y:number}[]} lm  Normalised landmarks.
 * @param {{x:number,y:number,z:number}[]} wl  Metric landmarks.
 * @param {number} fovY  Vertical field of view, radians.
 * @returns {number} Estimated wrist distance, metres, clamped.
 */
export function estimateDepth( lm, wl, fovY ) {

	const focal = 1 / Math.tan( fovY / 2 );

	// Apparent vertical extent of the hand in NDC (wrist -> middle MCP).
	const apparent = Math.abs( lm[ 9 ].y - lm[ 0 ].y ) * 2;   // *2: NDC spans 2
	const metric = Math.hypot( wl[ 9 ].x - wl[ 0 ].x, wl[ 9 ].y - wl[ 0 ].y, wl[ 9 ].z - wl[ 0 ].z );

	if ( apparent < 1e-4 || metric < 1e-4 ) return 0.8;

	const depth = ( metric * focal ) / apparent;
	return Math.min( Math.max( depth, 0.25 ), 2.5 );

}

/**
 * Pure: hand attitude from the landmark frame (wrist->middleMCP, knuckle axis).
 */
export function handQuaternion( wl, mirror, out = new Quaternion() ) {

	const sx = mirror ? - 1 : 1;
	_fwd.set( wl[ 9 ].x * sx, wl[ 9 ].y, wl[ 9 ].z ).normalize();
	_across.set( ( wl[ 5 ].x - wl[ 17 ].x ) * sx, wl[ 5 ].y - wl[ 17 ].y, wl[ 5 ].z - wl[ 17 ].z ).normalize();
	_up.crossVectors( _fwd, _across );
	if ( _up.lengthSq() < 1e-8 ) _up.set( 0, 1, 0 );
	_up.normalize();
	_across.crossVectors( _up, _fwd );

	return out.setFromRotationMatrix( _m.makeBasis( _across, _up, _fwd ) );

}

export class CameraHandProvider {

	/**
	 * @param {Object} opts
	 * @param {import('./HandState.js').HandState[]} opts.states  left/right.
	 * @param {() => import('three').PerspectiveCamera} opts.getCamera
	 * @param {string} [opts.wasmBase]
	 * @param {string} [opts.modelPath]
	 * @param {boolean}[opts.mirror]
	 */
	constructor( {
		states,
		getCamera,
		wasmBase = 'vendor/mediapipe/wasm',
		modelPath = 'vendor/mediapipe/hand_landmarker.task',
		mirror = true,
	} ) {

		this.states = states;
		this.getCamera = getCamera;
		this.wasmBase = wasmBase;
		this.modelPath = modelPath;
		this.mirror = mirror;

		this.active = false;
		this.ready = false;
		this.error = null;

		this._video = null;
		this._stream = null;
		this._landmarker = null;
		this._lastVideoTime = - 1;

		this._jointSets = new Map();   // handedness -> Map(name -> Vector3)

	}

	/**
	 * Request the camera and load the model. Safe to call once; subsequent
	 * calls resolve to the existing session.
	 */
	async start() {

		if ( this.active || this.ready ) return true;
		if ( this._starting ) return this._starting;

		this._starting = ( async () => {

			try {

				this._stream = await navigator.mediaDevices.getUserMedia( {
					video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
					audio: false,
				} );

				this._video = document.createElement( 'video' );
				this._video.muted = true;
				this._video.playsInline = true;
				this._video.srcObject = this._stream;
				await this._video.play();

				const vision = await import( '../../vendor/mediapipe/vision_bundle.mjs' );
				const fileset = await vision.FilesetResolver.forVisionTasks( this.wasmBase );

				const options = ( delegate ) => vision.HandLandmarker.createFromOptions( fileset, {
					baseOptions: { modelAssetPath: this.modelPath, delegate },
					runningMode: 'VIDEO',
					numHands: 2,
					minHandDetectionConfidence: 0.4,
					minHandPresenceConfidence: 0.4,
					minTrackingConfidence: 0.4,
				} );

				try {

					this._landmarker = await options( 'GPU' );

				} catch {

					this._landmarker = await options( 'CPU' );   // headless / older GPUs

				}

				this.ready = true;
				this.active = true;
				this.error = null;
				return true;

			} catch ( error ) {

				this.error = error?.message ?? String( error );
				this.active = false;
				this._cleanupMedia();
				throw error;

			} finally {

				this._starting = null;

			}

		} )();

		return this._starting;

	}

	stop() {

		this.active = false;
		this.ready = false;
		this._landmarker?.close?.();
		this._landmarker = null;
		this._cleanupMedia();

		for ( const state of this.states ) {

			if ( state.source === 'camera' ) {

				state.visible = false;
				state.connected = false;

			}

		}

	}

	_cleanupMedia() {

		this._stream?.getTracks().forEach( ( track ) => track.stop() );
		this._stream = null;
		this._video?.remove?.();
		this._video = null;

	}

	/**
	 * Run detection for this frame and fill the matching HandStates.
	 * @param {number} dt Seconds (unused; detection is throttled by video time).
	 */
	update( dt ) {

		if ( ! this.active || ! this.ready ) return;

		const video = this._video;
		if ( ! video || video.readyState < 2 ) return;
		if ( video.currentTime === this._lastVideoTime ) return;   // no new frame
		this._lastVideoTime = video.currentTime;

		const now = performance.now();
		const result = this._landmarker.detectForVideo( video, now );

		const seen = new Set();

		for ( let h = 0; h < ( result.landmarks?.length ?? 0 ); h ++ ) {

			const lm = result.landmarks[ h ];
			const wl = result.worldLandmarks[ h ];
			const label = ( result.handedness?.[ h ]?.[ 0 ]?.categoryName ?? 'Right' ).toLowerCase();

			const state = this.states.find( ( s ) => s.handedness === label );
			if ( ! state ) continue;
			seen.add( label );

			const camera = this.getCamera();
			const fovY = ( camera.fov * Math.PI ) / 180;

			/* wrist in the viewer camera's frustum */
			const depth = estimateDepth( lm, wl, fovY );
			const ndcX = this.mirror ? - ( lm[ 0 ].x * 2 - 1 ) : lm[ 0 ].x * 2 - 1;
			const ndcY = - ( lm[ 0 ].y * 2 - 1 );
			const tanY = Math.tan( fovY / 2 );
			const tanX = tanY * camera.aspect;

			_v.set( ndcX * depth * tanX, ndcY * depth * tanY, - depth );

			/* joints: wrist + metric landmark, into world space */
			const joints = mapLandmarksToJoints( wl, this.mirror, this._jointSets.get( label ) ?? undefined );
			this._jointSets.set( label, joints );

			camera.updateMatrixWorld();

			for ( const [ name, local ] of joints ) {

				const joint = state.joints.get( name );
				_w.copy( local ).add( _v ).applyMatrix4( camera.matrixWorld );
				joint.position.copy( _w );
				joint.radius = 0.008;
				joint.valid = true;

			}

			state.wrist.copy( state.joints.get( 'wrist' ).position );
			state.indexTip.copy( state.joints.get( 'index-finger-tip' ).position );
			state.thumbTip.copy( state.joints.get( 'thumb-tip' ).position );
			state.indexMcp.copy( state.joints.get( 'index-finger-metacarpal' ).position );
			state.palmCenter.copy( state.wrist ).lerp( state.indexMcp, 0.5 );

			state.pivotPosition.copy( state.indexTip ).add( state.thumbTip ).multiplyScalar( 0.5 );
			handQuaternion( wl, this.mirror, state.pivotQuaternion );

			// Metric pinch distance — the same signal XR provides.
			state.pinch.distance = Math.hypot(
				wl[ 4 ].x - wl[ 8 ].x, wl[ 4 ].y - wl[ 8 ].y, wl[ 4 ].z - wl[ 8 ].z
			);

			state.connected = true;
			state.visible = true;
			state.isXR = false;
			state.source = 'camera';

		}

		// Hands that vanished this frame must stop interacting immediately.
		for ( const state of this.states ) {

			if ( state.source === 'camera' && ! seen.has( state.handedness ) ) {

				state.visible = false;
				state.connected = false;

			}

		}

	}

	dispose() {

		this.stop();

	}

}
