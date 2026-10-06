/**
 * PinchDetector.js
 * ---------------------------------------------------------------------------
 * Thumb-to-index pinch with hysteresis.
 *
 * Optical hand tracking jitters by roughly 1-3 mm per frame. A single
 * threshold therefore flickers: a held pinch would register as
 * pinch/release/pinch/release and parts would drop out of the user's hand.
 *
 * Two thresholds fix it:
 *
 *   engage  when distance <= engageDistance   (default 21 mm)
 *   release when distance >= releaseDistance  (default 33 mm)
 *
 * Between the two the previous state is held, which gives a 12 mm dead band.
 * `strength` is a continuous 0..1 readout of how closed the pinch is, used to
 * grow the fingertip ring and to fade the "ready to grab" affordance.
 *
 * Pure logic, no three.js scene dependencies -> unit tested in Node.
 * ---------------------------------------------------------------------------
 */

import { clamp, saturateRange } from '../utils/mathUtils.js';

export class PinchDetector {

	/**
	 * @param {Object} [opts]
	 * @param {number} [opts.engageDistance]  Metres. Pinch closes below this.
	 * @param {number} [opts.releaseDistance] Metres. Pinch opens above this.
	 * @param {number} [opts.maxGrabSpeed]    m/s. Above this the pinch is treated
	 *        as a pass-by rather than an intentional grab (set to Infinity to disable).
	 */
	constructor( {
		engageDistance = 0.021,
		releaseDistance = 0.033,
		maxGrabSpeed = 3.5,
	} = {} ) {

		if ( releaseDistance <= engageDistance ) {

			throw new Error( 'PinchDetector: releaseDistance must exceed engageDistance (hysteresis band)' );

		}

		this.engageDistance = engageDistance;
		this.releaseDistance = releaseDistance;
		this.maxGrabSpeed = maxGrabSpeed;

		this.active = false;
		this.distance = Infinity;
		this.strength = 0;

		/** Set for exactly one frame on each transition. */
		this.justEngaged = false;
		this.justReleased = false;

	}

	/**
	 * @param {number} distance   Thumb-tip to index-tip distance in metres.
	 * @param {number} [tipSpeed] Fingertip speed in m/s (optional gate).
	 * @returns {{active: boolean, changed: boolean, strength: number, distance: number}}
	 */
	update( distance, tipSpeed = 0 ) {

		const was = this.active;

		this.distance = distance;

		if ( was ) {

			if ( distance >= this.releaseDistance ) this.active = false;

		} else {

			// Reject fast fly-bys: a hand sweeping past the model should not latch.
			if ( distance <= this.engageDistance && tipSpeed <= this.maxGrabSpeed ) this.active = true;

		}

		// 0 when the fingers are at the release distance, 1 when fully closed.
		this.strength = saturateRange( this.releaseDistance - distance, 0, this.releaseDistance - this.engageDistance );
		this.strength = clamp( this.strength, 0, 1 );

		this.justEngaged = this.active && ! was;
		this.justReleased = ! this.active && was;

		return {
			active: this.active,
			changed: this.justEngaged || this.justReleased,
			strength: this.strength,
			distance: this.distance,
		};

	}

	/** Force open (session end, hand lost, part released externally). */
	release() {

		const was = this.active;
		this.active = false;
		this.strength = 0;
		this.justReleased = was;
		this.justEngaged = false;
		return was;

	}

}
