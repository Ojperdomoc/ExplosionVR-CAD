/**
 * HandState.js
 * ---------------------------------------------------------------------------
 * Device-agnostic snapshot of one hand.
 *
 * The rest of the app never touches XRHand / XRJointSpace directly. Providers
 * (XRHandProvider for real hand tracking, SimHandProvider for the desktop
 * puppet) fill a HandState, and the interaction layer only ever reads this.
 * That single indirection is what makes the gesture code testable on a laptop
 * and in a headset with the same logic.
 * ---------------------------------------------------------------------------
 */

import { Quaternion, Vector3 } from 'three';

/** The 25 joints defined by the WebXR Hand Input module. */
export const JOINT_NAMES = Object.freeze( [
	'wrist',
	'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
	'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
	'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
	'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
	'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip',
] );

/** Parent of each joint — used to draw the bone skeleton between joints. */
export const BONE_LINKS = Object.freeze( [
	[ 'wrist', 'thumb-metacarpal' ],
	[ 'thumb-metacarpal', 'thumb-phalanx-proximal' ],
	[ 'thumb-phalanx-proximal', 'thumb-phalanx-distal' ],
	[ 'thumb-phalanx-distal', 'thumb-tip' ],
	[ 'wrist', 'index-finger-metacarpal' ],
	[ 'index-finger-metacarpal', 'index-finger-phalanx-proximal' ],
	[ 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate' ],
	[ 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal' ],
	[ 'index-finger-phalanx-distal', 'index-finger-tip' ],
	[ 'index-finger-metacarpal', 'middle-finger-metacarpal' ],
	[ 'middle-finger-metacarpal', 'middle-finger-phalanx-proximal' ],
	[ 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate' ],
	[ 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal' ],
	[ 'middle-finger-phalanx-distal', 'middle-finger-tip' ],
	[ 'middle-finger-metacarpal', 'ring-finger-metacarpal' ],
	[ 'ring-finger-metacarpal', 'ring-finger-phalanx-proximal' ],
	[ 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate' ],
	[ 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal' ],
	[ 'ring-finger-phalanx-distal', 'ring-finger-tip' ],
	[ 'ring-finger-metacarpal', 'pinky-finger-metacarpal' ],
	[ 'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal' ],
	[ 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate' ],
	[ 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal' ],
	[ 'pinky-finger-phalanx-distal', 'pinky-finger-tip' ],
	[ 'wrist', 'pinky-finger-metacarpal' ],
] );

export class HandState {

	/** @param {'left'|'right'} handedness */
	constructor( handedness ) {

		this.handedness = handedness;

		/** True when the runtime is reporting this hand at all. */
		this.connected = false;
		/** True this frame (tracking confidence ok / puppet enabled). */
		this.visible = false;
		/** True when the source is a real XRHand rather than the desktop puppet. */
		this.isXR = false;
		/** Which input drives this state: 'xr' | 'camera' | 'puppet'. */
		this.source = 'none';

		/** name -> { position, quaternion, radius, valid } in world space. */
		this.joints = new Map();
		for ( const name of JOINT_NAMES ) {

			this.joints.set( name, {
				position: new Vector3(),
				quaternion: new Quaternion(),
				radius: 0.008,
				valid: false,
			} );

		}

		/* Cached derived points — the interaction layer reads these constantly. */
		this.indexTip = new Vector3();
		this.thumbTip = new Vector3();
		this.wrist = new Vector3();
		this.indexMcp = new Vector3();
		this.palmCenter = new Vector3();

		/**
		 * Grab pivot: halfway between the pinching fingertips, oriented like the
		 * wrist. Using the wrist orientation keeps the held part from snapping to
		 * a new attitude the instant the pinch closes.
		 */
		this.pivotPosition = new Vector3();
		this.pivotQuaternion = new Quaternion();

		/** Pinch state, written by PinchDetector. */
		this.pinch = {
			active: false,
			distance: Infinity,
			/** 0 = fingers apart, 1 = fully closed. Drives the fingertip ring. */
			strength: 0,
			changed: false,
		};

		/**
		 * Smoothed 0..1 "how closed are the fingers" value.
		 * XRHandProvider lets PinchDetector derive it from the raw distance;
		 * SimHandProvider damps it so the puppet visibly closes.
		 */
		this.pinchStrength = 0;

		/** Fingertip speed in m/s — used to reject accidental grabs on fast passes. */
		this.tipVelocity = new Vector3();

	}

	getJoint( name ) {

		return this.joints.get( name );

	}

	/** Number of joints with a valid pose this frame. */
	validJointCount() {

		let n = 0;
		for ( const j of this.joints.values() ) if ( j.valid ) n ++;
		return n;

	}

	/** Convenience accessor used by GrabController. */
	get pivot() {

		return { position: this.pivotPosition, quaternion: this.pivotQuaternion };

	}

}
