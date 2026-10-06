/**
 * SimHandProvider.js
 * ---------------------------------------------------------------------------
 * A desktop "puppet hand".
 *
 * Requirement: the interface must be fully testable with no headset. Rather
 * than bolting a second, mouse-specific interaction path onto the app (which
 * would silently drift from the XR path), this provider synthesises the same 25
 * joint poses that a real XRHand would produce and writes them into the same
 * HandState. Proximity, pinch, grab and exploded-view logic are then exercised
 * by a mouse on a laptop exactly as they are by a hand in a headset.
 *
 * Controls (documented in the HUD):
 *   move pointer          -> puppet index fingertip follows the cursor
 *   left mouse button     -> pinch (engage / release)
 *   hold Shift            -> pointer drives the SECOND hand instead of the first
 *   Z / X                 -> latch pinch for hand 0 / hand 1 (lets you hold two
 *                            pinches at once, which is how the two-handed
 *                            exploded-view gesture is tested)
 *
 * The fingertip is placed exactly on the raycast hit so "what the cursor is
 * over" and "what the fingertip is near" cannot disagree.
 * ---------------------------------------------------------------------------
 */

import {
	Matrix4,
	Quaternion,
	Raycaster,
	Vector2,
	Vector3,
} from 'three';

import { JOINT_NAMES } from './HandState.js';
import { damp } from '../utils/mathUtils.js';

/* ---------------------------------------------------------------- *
 * Local-space skeleton (metres). Hand points down +Z, palm faces -Y,
 * thumb on +X for a right hand (mirrored for a left hand).
 * ---------------------------------------------------------------- */

const LOCAL = {
	'wrist': [ 0.000, 0.000, - 0.085 ],
	'thumb-metacarpal': [ 0.028, - 0.004, - 0.045 ],
	'thumb-phalanx-proximal': [ 0.037, - 0.009, - 0.014 ],
	'thumb-phalanx-distal': [ 0.039, - 0.011, 0.010 ],
	'thumb-tip': [ 0.034, - 0.011, 0.032 ],
	'index-finger-metacarpal': [ 0.020, 0.000, - 0.035 ],
	'index-finger-phalanx-proximal': [ 0.022, 0.000, 0.004 ],
	'index-finger-phalanx-intermediate': [ 0.022, 0.000, 0.038 ],
	'index-finger-phalanx-distal': [ 0.022, 0.000, 0.060 ],
	'index-finger-tip': [ 0.022, 0.000, 0.078 ],
	'middle-finger-metacarpal': [ 0.000, 0.000, - 0.037 ],
	'middle-finger-phalanx-proximal': [ 0.000, 0.000, 0.005 ],
	'middle-finger-phalanx-intermediate': [ 0.000, 0.000, 0.041 ],
	'middle-finger-phalanx-distal': [ 0.000, 0.000, 0.064 ],
	'middle-finger-tip': [ 0.000, 0.000, 0.083 ],
	'ring-finger-metacarpal': [ - 0.020, 0.000, - 0.036 ],
	'ring-finger-phalanx-proximal': [ - 0.021, 0.000, 0.003 ],
	'ring-finger-phalanx-intermediate': [ - 0.021, 0.000, 0.035 ],
	'ring-finger-phalanx-distal': [ - 0.021, 0.000, 0.055 ],
	'ring-finger-tip': [ - 0.021, 0.000, 0.072 ],
	'pinky-finger-metacarpal': [ - 0.038, 0.000, - 0.033 ],
	'pinky-finger-phalanx-proximal': [ - 0.040, 0.000, - 0.002 ],
	'pinky-finger-phalanx-intermediate': [ - 0.040, 0.000, 0.024 ],
	'pinky-finger-phalanx-distal': [ - 0.040, 0.000, 0.041 ],
	'pinky-finger-tip': [ - 0.040, 0.000, 0.055 ],
};

/** Joints that curl with the fingers, grouped so the tip curls most. */
const CURL_WEIGHT = { proximal: 0.35, intermediate: 0.7, distal: 0.95, tip: 1.0 };

const _raycaster = /* @__PURE__ */ new Raycaster();
const _ndc = /* @__PURE__ */ new Vector2();
const _local = /* @__PURE__ */ new Vector3();
const _indexTipLocal = /* @__PURE__ */ new Vector3();
const _world = /* @__PURE__ */ new Vector3();
const _forward = /* @__PURE__ */ new Vector3();
const _right = /* @__PURE__ */ new Vector3();
const _up = /* @__PURE__ */ new Vector3();
const _m = /* @__PURE__ */ new Matrix4();
const _q = /* @__PURE__ */ new Quaternion();
const UP = /* @__PURE__ */ new Vector3( 0, 1, 0 );

export class SimHandProvider {

	/**
	 * @param {Object} opts
	 * @param {import('./HandState.js').HandState} opts.state
	 * @param {import('three').PerspectiveCamera} opts.camera
	 * @param {HTMLElement} opts.domElement      Element receiving pointer events.
	 * @param {() => Object3D[]} opts.getTargets Returns pickable objects (part proxies).
	 * @param {() => import('three').Plane} [opts.fallbackPlane] Plane used when the ray hits nothing.
	 * @param {boolean} [opts.secondary]         When true this hand only follows the pointer while Shift is held.
	 */
	constructor( { state, camera, domElement, getTargets, fallbackPlane, secondary = false } ) {

		this.state = state;
		this.camera = camera;
		this.domElement = domElement;
		this.getTargets = getTargets;
		this.fallbackPlane = fallbackPlane;
		this.secondary = secondary;

		this.enabled = ! secondary;   // the secondary hand starts parked

		this.targetPoint = new Vector3( 0, 1.0, 0.3 );
		this.smoothPoint = this.targetPoint.clone();
		this.hitSomething = false;

		this._pinchLatch = false;
		this._mouseDown = false;
		this._pinchRequested = false;
		this._shiftHeld = false;
		this._needsRaycast = true;
		this._time = 0;
		this._attached = false;

		/** Optional callback: (pinching: boolean) => void. Used for haptics/SFX. */
		this.onPinchChange = null;

		this._onPointerMove = this._onPointerMove.bind( this );
		this._onPointerDown = this._onPointerDown.bind( this );
		this._onPointerUp = this._onPointerUp.bind( this );
		this._onKeyDown = this._onKeyDown.bind( this );
		this._onKeyUp = this._onKeyUp.bind( this );

	}

	/* ---------------------------------------------------------- *
	 * Listener lifecycle
	 * ---------------------------------------------------------- */

	attach() {

		if ( this._attached ) return;
		this._attached = true;

		this.domElement.addEventListener( 'pointermove', this._onPointerMove );
		this.domElement.addEventListener( 'pointerdown', this._onPointerDown );
		window.addEventListener( 'pointerup', this._onPointerUp );
		window.addEventListener( 'keydown', this._onKeyDown );
		window.addEventListener( 'keyup', this._onKeyUp );

	}

	detach() {

		if ( ! this._attached ) return;
		this._attached = false;

		this.domElement.removeEventListener( 'pointermove', this._onPointerMove );
		this.domElement.removeEventListener( 'pointerdown', this._onPointerDown );
		window.removeEventListener( 'pointerup', this._onPointerUp );
		window.removeEventListener( 'keydown', this._onKeyDown );
		window.removeEventListener( 'keyup', this._onKeyUp );

	}

	_onPointerMove( event ) {

		if ( event.shiftKey !== this._shiftHeld ) this._shiftHeld = event.shiftKey;

		// Only the hand that currently "owns" the pointer follows it.
		if ( this.secondary === !! event.shiftKey ) {

			const rect = this.domElement.getBoundingClientRect();
			_ndc.x = ( ( event.clientX - rect.left ) / rect.width ) * 2 - 1;
			_ndc.y = - ( ( event.clientY - rect.top ) / rect.height ) * 2 + 1;
			this._needsRaycast = true;

		}

	}

	_onPointerDown( event ) {

		if ( this.secondary === !! event.shiftKey && event.button === 0 ) {

			this._mouseDown = true;
			this._updatePinchFromInput();
			// Let the caller know a grab was requested this frame.
			this.onPinchChange?.( true );

		}

	}

	_onPointerUp() {

		this._mouseDown = false;
		this._updatePinchFromInput();
		this.onPinchChange?.( false );

	}

	_onKeyDown( event ) {

		if ( event.repeat ) return;
		const key = event.key.toLowerCase();
		if ( key === 'z' && ! this.secondary ) {

			this._pinchLatch = ! this._pinchLatch;
			this._updatePinchFromInput();

		}
		if ( key === 'x' && this.secondary ) {

			this._pinchLatch = ! this._pinchLatch;
			this._updatePinchFromInput();

		}

	}

	_onKeyUp() { /* latches are toggles, so nothing to do */ }

	_updatePinchFromInput() {

		this._pinchRequested = this._pinchLatch || this._mouseDown;

	}

	/** Programmatic pinch — used by automated tests and by the HUD buttons. */
	setPinch( on ) {

		this._pinchLatch = !! on;
		this._updatePinchFromInput();
		this.onPinchChange?.( !! on );

	}

	setEnabled( on ) {

		this.enabled = !! on;
		if ( ! on ) {

			this.state.visible = false;
			this._pinchLatch = false;
			this._mouseDown = false;
			this._pinchRequested = false;

		}

	}

	/* ---------------------------------------------------------- *
	 * Pose synthesis
	 * ---------------------------------------------------------- */

	/**
	 * @param {number} dt  Seconds.
	 * @returns {import('./HandState.js').HandState}
	 */
	update( dt ) {

		const state = this.state;

		if ( ! this.enabled ) {

			state.visible = false;
			state.connected = false;
			return state;

		}

		this._time += dt;

		if ( this._needsRaycast ) {

			this._needsRaycast = false;
			this._raycast();

		}

		// Smooth the cursor so the puppet does not teleport across frames.
		this.smoothPoint.lerp( this.targetPoint, 1 - Math.exp( - 26 * dt ) );

		state.connected = true;
		state.visible = true;
		state.isXR = false;
		state.source = 'puppet';

		/* --- basis: the hand points from the viewer towards the target --- */

		_forward.copy( this.smoothPoint ).sub( this.camera.position ).normalize();
		_right.crossVectors( _forward, UP );
		if ( _right.lengthSq() < 1e-6 ) _right.set( 1, 0, 0 );
		_right.normalize();
		_up.crossVectors( _right, _forward ).normalize();

		// Mirror for a left hand so the thumb ends up on the correct side.
		const mirror = state.handedness === 'left' ? - 1 : 1;
		if ( mirror < 0 ) _right.multiplyScalar( - 1 );

		_m.makeBasis( _right, _up, _forward );
		_q.setFromRotationMatrix( _m );

		/* --- curl + pinch amount --------------------------------------- */

		const wantPinch = !! this._pinchRequested;
		state.pinchStrength = damp( state.pinchStrength ?? 0, wantPinch ? 1 : 0, 16, dt );
		const curl = 0.10 + state.pinchStrength * 0.75;

		/* --- write joints ------------------------------------------------ */

		// The index fingertip is the anchor: it must land exactly on the cursor.
		// Its curled position is computed FIRST, because both the hand origin and
		// the thumb's pinch target have to agree with where the tip actually is.
		// Getting this wrong is what makes a puppet whose fingers can never
		// touch — the pinch detector would then never engage.
		_indexTipLocal.fromArray( LOCAL[ 'index-finger-tip' ] );
		_indexTipLocal.x *= mirror;
		this._applyCurl( 'index-finger-tip', _indexTipLocal, curl );

		_world.copy( _indexTipLocal ).applyQuaternion( _q );

		const originX = this.smoothPoint.x - _world.x;
		const originY = this.smoothPoint.y - _world.y;
		const originZ = this.smoothPoint.z - _world.z;

		// Sub-millimetre idle drift so the puppet reads as alive, not frozen.
		const breathe = Math.sin( this._time * 1.6 ) * 0.0006;

		for ( const name of JOINT_NAMES ) {

			const joint = state.joints.get( name );
			_local.fromArray( LOCAL[ name ] );
			_local.x *= mirror;

			this._applyCurl( name, _local, curl );

			// Pinch pulls the thumb towards where the index tip actually is.
			// At full strength the tips coincide, so the measured pinch distance
			// goes to ~0 and the detector engages deterministically.
			if ( name.startsWith( 'thumb-' ) ) {

				const amount = name === 'thumb-tip' ? 1 : 0.55;
				_local.lerp( _indexTipLocal, state.pinchStrength * amount );

			}

			_local.applyQuaternion( _q );
			joint.position.set( originX + _local.x, originY + _local.y + breathe, originZ + _local.z );

			// The puppet's joints all share the hand attitude; only the wrist
			// orientation is actually read downstream (for the grab pivot), and
			// the joint spheres are orientation-invariant.
			joint.quaternion.copy( _q );
			joint.radius = 0.0075;
			joint.valid = true;

		}

		/* --- derived quantities, mirroring XRHandProvider ---------------- */

		state.indexTip.copy( state.joints.get( 'index-finger-tip' ).position );
		state.thumbTip.copy( state.joints.get( 'thumb-tip' ).position );
		state.wrist.copy( state.joints.get( 'wrist' ).position );
		state.indexMcp.copy( state.joints.get( 'index-finger-metacarpal' ).position );
		state.palmCenter.copy( state.wrist ).lerp( state.indexMcp, 0.5 );

		state.pivotPosition.copy( state.indexTip ).add( state.thumbTip ).multiplyScalar( 0.5 );
		state.pivotQuaternion.copy( _q );

		state.pinch.distance = state.indexTip.distanceTo( state.thumbTip );

		return state;

	}

	/** Rotate a finger's joints about the hand's local X axis to fake a curl. */
	_applyCurl( name, local, curl ) {

		const finger = name.split( '-' )[ 0 ];
		const kind = name.includes( 'proximal' ) ? 'proximal'
			: name.includes( 'intermediate' ) ? 'intermediate'
				: name.includes( 'distal' ) ? 'distal'
					: name.endsWith( 'tip' ) ? 'tip' : null;

		if ( ! kind || finger === 'thumb' ) return;

		// Thumb-side fingers curl about +X, so the sign follows the mirror.
		const angle = curl * CURL_WEIGHT[ kind ] * 0.42;
		const cos = Math.cos( angle );
		const sin = Math.sin( angle );
		const y = local.y;
		const z = local.z;
		local.y = y * cos - z * sin;
		local.z = y * sin + z * cos;

	}

	_raycast() {

		_raycaster.setFromCamera( _ndc, this.camera );
		_raycaster.layers.enableAll();

		const hits = _raycaster.intersectObjects( this.getTargets(), true );

		if ( hits.length > 0 ) {

			this.targetPoint.copy( hits[ 0 ].point );
			// Pull back 6 mm along the ray so the fingertip rests just off the
			// surface, which is where a real fingertip would be when hovering.
			this.targetPoint.addScaledVector( _raycaster.ray.direction, - 0.006 );
			this.hitSomething = true;
			return;

		}

		const plane = this.fallbackPlane?.();
		if ( plane ) {

			const hit = _raycaster.ray.intersectPlane( plane, this.targetPoint );
			if ( hit ) {

				this.hitSomething = false;
				return;

			}

		}

		// Last resort: park the hand a fixed distance in front of the camera.
		this.targetPoint.copy( _raycaster.ray.direction ).multiplyScalar( 0.8 ).add( this.camera.position );
		this.hitSomething = false;

	}

	dispose() {

		this.detach();

	}

}

/** Small helper so the HUD can report which hand the Shift key is driving. */
export const simHandHint = ( shiftHeld ) =>
	shiftHeld ? 'Shift held — pointer drives the RIGHT puppet hand' : 'Pointer drives the LEFT puppet hand';

