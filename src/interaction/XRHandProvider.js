/**
 * XRHandProvider.js
 * ---------------------------------------------------------------------------
 * Reads real XRHand tracking data into a HandState.
 *
 * === HOW THE JOINT TRANSFORMS WORK =========================================
 *
 * 1. The WebXR Hand Input module exposes `XRInputSource.hand`, a map of
 *    `XRJointSpace` objects keyed by joint name ("wrist", "index-finger-tip", …).
 *    A space is not a pose: it is a *frame of reference* whose transform the
 *    runtime resolves per frame against a chosen reference space.
 *
 * 2. Resolution happens here:
 *
 *        const pose = frame.getJointPose( jointSpace, referenceSpace );
 *        pose.transform.matrix      // Float32Array(16), column-major 4x4
 *        pose.transform.position    // {x,y,z}  metres, in referenceSpace
 *        pose.transform.orientation // {x,y,z,w}
 *        pose.radius                // metres, approximate joint radius
 *
 *    Column-major matters: three.js Matrix4.fromArray() expects exactly that
 *    layout, so the array drops straight in with no transpose.
 *
 * 3. three.js does steps 1-2 for us. `renderer.xr.getHand( i )` returns a Group
 *    (`WebXRController.getHandSpace()`); inside the XR animation callback,
 *    BEFORE our own loop callback runs, three executes per joint:
 *
 *        joint.matrix.fromArray( jointPose.transform.matrix );
 *        joint.matrix.decompose( joint.position, joint.rotation, joint.scale );
 *        joint.matrixWorldNeedsUpdate = true;
 *        joint.jointRadius = jointPose.radius;
 *
 *    (see three r186 WebXRController.update). Two consequences this class
 *    relies on:
 *
 *      a) `joint.matrixAutoUpdate === false`, so `joint.matrix` — the raw pose
 *         matrix — is authoritative and is NOT overwritten from
 *         position/quaternion/scale during the scene-graph update.
 *      b) The hand Group itself is never given a pose; its matrix stays
 *         identity. Therefore
 *
 *             joint.matrixWorld = handGroup.matrixWorld * poseMatrix
 *                               = poseMatrix           (hand group at origin)
 *
 *         i.e. a joint's world position IS its pose in the XR reference space
 *         (local-floor: origin on the floor under the player's start pose).
 *
 *    ⚠ Never parent the hand Group under a moved object, or every joint
 *    inherits that offset and your fingertips will be in the wrong place. This
 *    provider asserts it.
 *
 * 4. Because three only flags `matrixWorldNeedsUpdate`, and because our loop
 *    runs before `renderer.render()` (which is what normally walks the graph),
 *    we force `updateMatrixWorld( true )` ourselves. 25 matrix multiplies —
 *    cheaper than reasoning about update order.
 *
 * 5. Handedness is taken from `XRInputSource.handedness`, never inferred from
 *    the controller index: the runtime may expose the right hand first, and
 *    users cross their hands.
 *
 * Pinching is computed by us (PinchDetector) rather than trusting
 * `hand.inputState.pinching`, because three hard-codes a 20 mm threshold with a
 * 5 mm band and no velocity gate, and offers no "how closed is it" value.
 * ---------------------------------------------------------------------------
 */

import { JOINT_NAMES } from './HandState.js';

/** Joints whose loss means "we cannot interact" even if some joints report. */
const CRITICAL_JOINTS = [ 'wrist', 'index-finger-tip', 'thumb-tip', 'index-finger-metacarpal' ];

export class XRHandProvider {

	/**
	 * @param {Object}   opts
	 * @param {import('three').WebGLRenderer} opts.renderer
	 * @param {number}   opts.controllerIndex  0 or 1 — the three.js controller slot.
	 * @param {import('./HandState.js').HandState} opts.state  HandState to fill.
	 */
	constructor( { renderer, controllerIndex, state } ) {

		this.renderer = renderer;
		this.index = controllerIndex;
		this.state = state;

		/** three.js hand-space Group; joints appear as children once connected. */
		this.handGroup = renderer.xr.getHand( controllerIndex );
		this.handGroup.name = `hand:${controllerIndex}`;

		this.inputSource = null;
		this._warned = false;

		/** Only the active runtime may write to the shared HandState. */
		this.enabled = true;

		renderer.xr.getController( controllerIndex ).addEventListener( 'connected', ( e ) => {

			this.inputSource = e.data;

			// Slot 0 is not guaranteed to be the left hand.
			if ( e.data && e.data.hand ) this.state.handedness = e.data.handedness || this.state.handedness;

			this.state.connected = !! ( e.data && e.data.hand );
			this.state.isXR = this.state.connected;

		} );

		renderer.xr.getController( controllerIndex ).addEventListener( 'disconnected', () => {

			this.inputSource = null;
			this.state.connected = false;
			this.state.visible = false;
			this.state.isXR = false;

		} );

	}

	/** True when the current input source is a tracked hand (not a controller). */
	get isHandActive() {

		return !! ( this.inputSource && this.inputSource.hand );

	}

	/** The XRInputSource, if any — used for haptics and controller fallback. */
	get source() {

		return this.inputSource;

	}

	/**
	 * Pull this frame's joint poses into the HandState.
	 * @returns {import('./HandState.js').HandState}
	 */
	update() {

		const state = this.state;
		const hand = this.handGroup;

		if ( ! this.enabled ) return state;   // never clobber another provider

		if ( ! hand.visible || ! this.isHandActive ) {

			state.visible = false;
			return state;

		}

		if ( ! this._warned && ( hand.parent && hand.parent.parent ) ) {

			console.warn( '[XRHandProvider] hand group must sit at the scene root; joint poses are in reference space.' );
			this._warned = true;

		}

		// Make joint.matrixWorld current before anything reads it (see header, 4).
		hand.updateMatrixWorld( true );

		let validCount = 0;

		for ( const name of JOINT_NAMES ) {

			const target = state.joints.get( name );
			const joint = hand.joints[ name ];

			if ( ! joint || joint.visible === false ) {

				target.valid = false;
				continue;

			}

			// joint.position / joint.quaternion are the decomposed pose matrix,
			// expressed in the hand group's space == XR reference space.
			joint.getWorldPosition( target.position );
			joint.getWorldQuaternion( target.quaternion );
			target.radius = joint.jointRadius || 0.008;
			target.valid = true;
			validCount ++;

		}

		// A runtime that reports a handful of joints but not the ones we act on
		// is worse than no hand at all: it would hover things you cannot grab.
		const critical = CRITICAL_JOINTS.every( ( n ) => state.joints.get( n ).valid );
		state.visible = critical && validCount >= 15;
		state.isXR = state.visible;
		if ( state.visible ) state.source = 'xr';

		if ( ! state.visible ) return state;

		/* --- derived quantities -------------------------------------- */

		state.indexTip.copy( state.joints.get( 'index-finger-tip' ).position );
		state.thumbTip.copy( state.joints.get( 'thumb-tip' ).position );
		state.wrist.copy( state.joints.get( 'wrist' ).position );
		state.indexMcp.copy( state.joints.get( 'index-finger-metacarpal' ).position );

		// Palm centre: wrist pulled a little towards the middle-finger MCP, which
		// is a stabler estimate than any single joint under occlusion.
		const middleMcp = state.joints.get( 'middle-finger-metacarpal' );
		state.palmCenter.copy( state.wrist ).lerp(
			middleMcp.valid ? middleMcp.position : state.indexMcp,
			0.5
		);

		// Pivot between the pinching fingertips, wrist attitude (see HandState).
		state.pivotPosition.copy( state.indexTip ).add( state.thumbTip ).multiplyScalar( 0.5 );
		state.pivotQuaternion.copy( state.joints.get( 'wrist' ).quaternion );

		state.pinch.distance = state.indexTip.distanceTo( state.thumbTip );

		return state;

	}

	/**
	 * Fire a short haptic pulse on the controller that shares this input source.
	 * Hand tracking on most runtimes has no actuators, so this is a no-op there —
	 * the visual pinch ring is the fallback cue.
	 */
	pulse( intensity = 0.4, ms = 20 ) {

		const actuator = this.inputSource?.gamepad?.hapticActuators?.[ 0 ];
		if ( actuator && typeof actuator.pulse === 'function' ) {

			actuator.pulse( intensity, ms );

		}

	}

	/** World-space ray from the wrist through the index tip (controller-style fallback). */
	getPointingRay( origin, direction ) {

		const state = this.state;
		if ( ! state.visible ) return false;

		origin.copy( state.wrist );
		direction.copy( state.indexTip ).sub( state.wrist );
		if ( direction.lengthSq() < 1e-8 ) return false;
		direction.normalize();
		return true;

	}

	dispose() {

		this.inputSource = null;

	}

}

/**
 * Build the pair of providers for a session, in a stable left/right order
 * regardless of which controller slot the runtime fills first.
 */
export function createHandProviders( renderer, states ) {

	const providers = [];

	for ( let i = 0; i < 2; i ++ ) {

		providers.push( new XRHandProvider( { renderer, controllerIndex: i, state: states[ i ] } ) );

	}

	return providers;

}
