/**
 * ExplodeController.js
 * ---------------------------------------------------------------------------
 * Drives the exploded view.
 *
 * One normalised scalar `t` (0 = assembled, 1 = fully exploded) is damped
 * towards a target. Each part remaps that scalar through its own delay so the
 * outer components lead and the inner ones follow — the mechanical "peel"
 * readers expect from a service manual.
 *
 *   localT_i = ease( clamp( (t - delay_i) / (1 - delay_i) ) )
 *   offset_i = dir_i * distance_i * localT_i
 *
 * Two ways to drive it:
 *   setExploded(true/false)  discrete toggle (button, trigger, key)
 *   setAmount(0..1)          continuous, from the two-hands-apart gesture
 *
 * Grabbed parts are skipped: a hand that is holding a component owns its
 * transform, and fighting it would teleport the part out of the user's grip.
 * ---------------------------------------------------------------------------
 */

import { Vector3 } from 'three';

import { clamp, damp, easeOutCubic } from '../utils/mathUtils.js';

const _offset = /* @__PURE__ */ new Vector3();

export class ExplodeController {

	/**
	 * @param {import('./MachinePart.js').MachinePart[]} parts
	 * @param {Object} [opts]
	 * @param {number} [opts.lambda] Damping speed for the animated target.
	 */
	constructor( parts, { lambda = 5.5 } = {} ) {

		this.parts = parts;
		this.lambda = lambda;

		this.t = 0;
		this.target = 0;

		/** True when an external continuous source (hands) is driving `target`. */
		this.continuous = false;

		/** Set when `t` changed this frame — lets the app know to refresh shadows. */
		this.dirty = false;

	}

	get isExploded() {

		return this.target > 0.5;

	}

	/** Discrete toggle / explicit set. Releases any continuous driver. */
	setExploded( exploded, { continuous = false } = {} ) {

		this.target = clamp( exploded ? 1 : 0, 0, 1 );
		this.continuous = continuous;
		return this.target;

	}

	/** Continuous drive from the two-hand pull-apart gesture. */
	setAmount( amount ) {

		this.target = clamp( amount, 0, 1 );
		this.continuous = true;
		return this.target;

	}

	/** Stop the continuous driver without moving the current target. */
	release() {

		this.continuous = false;

	}

	/**
	 * Advance the animation and write part transforms.
	 *
	 * @param {number} dt Seconds since the last frame (already clamped).
	 * @returns {boolean} True if any part moved.
	 */
	update( dt ) {

		const previous = this.t;
		this.t = damp( this.t, this.target, this.lambda, dt );

		// Snap when the remaining travel is sub-millimetre: stops the endless
		// asymptotic tail from keeping shadow maps dirty forever.
		if ( Math.abs( this.target - this.t ) < 0.0008 ) this.t = this.target;

		this.dirty = this.t !== previous;

		for ( const part of this.parts ) {

			if ( part.grabbed ) continue;

			const span = 1 - part.explodeDelay;
			const local = span > 0 ? clamp( ( this.t - part.explodeDelay ) / span, 0, 1 ) : 1;
			const eased = easeOutCubic( local );

			_offset.copy( part.explodeDir ).multiplyScalar( part.explodeDistance * eased );

			part.group.position.copy( part.homePosition ).add( _offset );

		}

		return this.dirty;

	}

	/** Instantly return every part home (ignores hands). */
	reset() {

		this.target = 0;
		this.continuous = false;
		for ( const part of this.parts ) part.resetHome();
		this.t = 0;
		this.dirty = true;
		return this;

	}

}
