/**
 * HandInteractionController.js
 * ---------------------------------------------------------------------------
 * The gesture layer. Consumes HandStates, produces intent.
 *
 * === THE GESTURE RULES =====================================================
 *
 * HOVER      index fingertip within `hoverPad` of a component's bounding
 *            sphere -> that component glows and its spec panel appears.
 *            Continuous, no click required: hands do not have cursors.
 *
 * GRAB       pinch (thumb + index) while hovering a component. One hand gives
 *            6-DOF move + rotate. Releasing drops the part where it is.
 *
 * 2-HAND     pinch the SAME component with the second hand -> relative pose
 * GRAB       mode (rotate about the axis between the hands).
 *
 * EXPLODE    pinch two DIFFERENT components (or one component and the bare
 *            housing) and pull the hands apart. Span beyond the latched rest
 *            distance drives the exploded view continuously; letting go snaps
 *            to whichever end is nearer. Distinct components are the tell —
 *            that is what separates "explode the machine" from "hold this
 *            part with both hands".
 *
 * TAP        pinch over a spatial-menu button activates it.
 *
 * All thresholds live in one config object so they can be tuned per runtime:
 * Quest hand tracking is noisier than a Leap Motion, and a glove changes the
 * effective fingertip position entirely.
 * ---------------------------------------------------------------------------
 */

import { Vector3 } from 'three';

import { PinchDetector } from './PinchDetector.js';
import { GrabController } from './GrabController.js';
import { partsNearPoint, resolveHover } from './ProximitySensor.js';
import { clamp, damp, ramp } from '../utils/mathUtils.js';

export const DEFAULT_GESTURE_CONFIG = Object.freeze( {
	/** Metres of reach beyond a component's bounding sphere. */
	hoverPad: 0.028,
	/** Slack that keeps the current hover from flickering to a neighbour. */
	hoverBias: 0.014,
	pinch: { engageDistance: 0.021, releaseDistance: 0.033, maxGrabSpeed: 3.5 },
	/** How far the hands must travel past their rest span to fully explode. */
	explodePullStart: 0.05,
	explodePullEnd: 0.26,
	/** Both hands must be this close to the machine to latch the gesture. */
	explodeLatchPad: 0.06,
	highlightLambda: 12,
} );

export class HandInteractionController {

	/**
	 * @param {Object} opts
	 * @param {import('./HandState.js').HandState[]} opts.hands
	 * @param {Object} opts.assembly   { group, parts }
	 * @param {import('../machine/ExplodeController.js').ExplodeController} opts.explode
	 * @param {Object} [opts.tooltip]  Spatial tooltip (show/hide/follow).
	 * @param {Object} [opts.menu]     Spatial menu (hit test + activate).
	 * @param {Object} [opts.config]   Override DEFAULT_GESTURE_CONFIG.
	 */
	constructor( { hands, assembly, explode, tooltip = null, menu = null, config = {} } ) {

		this.hands = hands;
		this.assembly = assembly;
		this.explode = explode;
		this.tooltip = tooltip;
		this.menu = menu;
		this.config = { ...DEFAULT_GESTURE_CONFIG, ...config };

		this.grab = new GrabController();
		this.pinchDetectors = hands.map( () => new PinchDetector( this.config.pinch ) );

		/** Per-hand hover result so the two-hand rules can be evaluated. */
		this.hoverPerHand = hands.map( () => null );
		this.hoveredPart = null;

		this.grabHandIndex = -1;
		this.secondHandIndex = -1;

		this.explodeLatch = false;
		this.explodeRestSpan = 0;
		this.explodeAmount = 0;

		this._prevTip = hands.map( () => new Vector3() );
		this._tipSpeed = hands.map( () => 0 );

		/** Optional callbacks, wired to the HUD / audio / haptics. */
		this.onHoverChange = null;
		this.onGrabChange = null;
		this.onExplodeLatch = null;
		this.onMenuActivate = null;
		this.onPulse = null;

		this.grab.onGrab = ( part ) => this.onGrabChange?.( part, true );
		this.grab.onRelease = ( part ) => this.onGrabChange?.( part, false );

	}

	/**
	 * One frame of interaction.
	 * @param {number} dt Clamped delta seconds.
	 */
	update( dt ) {

		const { assembly, hands, config } = this;

		// Fresh world matrices: the render pass has not run yet for this frame,
		// and both the bounding spheres and the grab maths need current values.
		assembly.group.updateMatrixWorld( true );
		for ( const part of assembly.parts ) part.updateWorldSphere();

		/* --- 1. hands + pinch ---------------------------------------- */

		for ( let i = 0; i < hands.length; i ++ ) {

			const state = hands[ i ];
			const detector = this.pinchDetectors[ i ];

			if ( ! state.visible ) {

				if ( detector.active ) detector.release();
				state.pinch.active = false;
				state.pinch.changed = false;
				this._clearHand( i );
				continue;

			}

			// Fingertip speed, for the fly-by rejection in PinchDetector.
			const speed = dt > 0 ? state.indexTip.distanceTo( this._prevTip[ i ] ) / dt : 0;
			this._tipSpeed[ i ] = damp( this._tipSpeed[ i ], speed, 12, dt );
			this._prevTip[ i ].copy( state.indexTip );

			const result = detector.update( state.pinch.distance, this._tipSpeed[ i ] );

			state.pinch.active = result.active;
			state.pinch.changed = result.changed;
			state.pinch.strength = result.strength;

			// The puppet damps this itself; XR and camera hands get it from the
			// measured (metric) fingertip distance.
			if ( state.source !== 'puppet' ) state.pinchStrength = result.strength;

			/* --- 2. proximity hover ------------------------------------ */

			// Broad-phase spheres gate the test; a narrow-phase raycast decides
			// which component the fingertip is actually on. Without the raycast
			// an enclosed component can never be distinguished from the housing
			// around it.
			this.hoverPerHand[ i ] = resolveHover( state, assembly.parts, {
				pad: config.hoverPad,
				bias: config.hoverBias,
				preferId: this.hoveredPart?.id ?? null,
			} );

			/* --- 3. pinch transitions ---------------------------------- */

			if ( detector.justEngaged ) this._onPinchEngage( i );
			if ( detector.justReleased ) this._onPinchRelease( i );

		}

		/* --- 4. single "best" hover for the UI ----------------------- */

		const previousHover = this.hoveredPart;
		let best = null;

		for ( let i = 0; i < this.hoverPerHand.length; i ++ ) {

			const hit = this.hoverPerHand[ i ];
			if ( hit && ( ! best || hit.gap < best.gap ) ) best = hit;

		}

		// A part in hand always outranks a part merely being looked at.
		this.hoveredPart = this.grab.isGrabbing ? this.grab.part : ( best ? best.part : null );

		if ( this.hoveredPart !== previousHover ) {

			this.onHoverChange?.( this.hoveredPart );

		}

		/* --- 5. exploded view ---------------------------------------- */

		this._updateExplodeGesture();
		this.explode.update( dt );

		/* --- 6. grabbed part follows its hand ------------------------ */

		let moved = false;

		if ( this.grab.isGrabbing ) {

			const a = hands[ this.grabHandIndex ];
			const b = this.secondHandIndex >= 0 ? hands[ this.secondHandIndex ] : null;

			if ( a && a.visible ) {

				moved = this.grab.update( a.pivot, b && b.visible ? b.pivot : null, dt );

			} else {

				// Tracking was lost mid-grab: do not leave the part floating in
				// a hand that is no longer there.
				this.grab.release();
				this.grabHandIndex = -1;
				this.secondHandIndex = -1;

			}

		}

		/* --- 7. highlight -------------------------------------------- */

		for ( const part of assembly.parts ) {

			const target = ( part === this.hoveredPart || part.grabbed ) ? 1 : 0;
			part.highlight = damp( part.highlight, target, config.highlightLambda, dt );
			if ( part.highlight < 0.002 ) part.highlight = 0;
			part.setHighlight( part.highlight );

		}

		/* --- 8. spatial UI ------------------------------------------- */

		if ( this.tooltip ) {

			if ( this.hoveredPart ) this.tooltip.show( this.hoveredPart );
			else this.tooltip.hide();
			this.tooltip.update( dt );

		}

		if ( this.menu ) this.menu.update( hands, dt );

		return { moved, hover: this.hoveredPart, explode: this.explode.t };

	}

	/* ------------------------------------------------------------------ *
	 * Pinch transitions
	 * ------------------------------------------------------------------ */

	_onPinchEngage( i ) {

		const hands = this.hands;
		const hit = this.hoverPerHand[ i ];
		const other = 1 - i;
		const otherPinched = !! hands[ other ]?.pinch.active;
		const otherOnMachine = this._handOnMachine( other );

		// TAP on the spatial menu wins when the finger is over a button.
		if ( this.menu && ! hit ) {

			const id = this.menu.pick( hands[ i ] );
			if ( id ) {

				this.menu.activate( id );
				this.onMenuActivate?.( id );
				this.onPulse?.( i, 0.5, 25 );
				return;

			}

		}

		if ( ! hit ) return;

		const part = hit.part;
		const holdingThisPart = this.grab.isGrabbing && this.grab.part === part;

		// TWO-HAND GRAB: the second hand closes on the component already held.
		// Checked before the explode rule, because "same component" is the one
		// case that must NOT be read as "pull the machine apart".
		if ( holdingThisPart && this.secondHandIndex < 0 ) {

			const a = hands[ this.grabHandIndex ];
			if ( a && a.visible && this.grab.addSecondHand( a.pivot, hands[ i ].pivot ) ) {

				this.secondHandIndex = i;
				this.onPulse?.( i, 0.35, 18 );

			}
			return;

		}

		// EXPLODE: both hands pinched on the machine, on DIFFERENT components.
		// This has to run even when the first hand already took a grab — the
		// natural sequence is "pinch A, pinch B, pull apart", and requiring the
		// machine to be untouched would make the gesture unreachable.
		if ( otherPinched && otherOnMachine ) {

			this._beginExplodeLatch( i, other );
			return;

		}

		// SINGLE-HAND GRAB.
		if ( ! this.grab.isGrabbing ) {

			this.grab.attach( part, hands[ i ].pivot, this.assembly.group );
			this.grabHandIndex = i;
			this.secondHandIndex = -1;
			this.onPulse?.( i, 0.6, 30 );

		}

	}

	_onPinchRelease( i ) {

		if ( this.explodeLatch ) this._endExplodeLatch();

		if ( i === this.secondHandIndex ) {

			const a = this.hands[ this.grabHandIndex ];
			if ( a && a.visible ) this.grab.dropSecondHand( a.pivot );
			this.secondHandIndex = -1;
			return;

		}

		if ( i === this.grabHandIndex ) {

			// If the other hand is still pinched on the part, hand ownership over.
			if ( this.secondHandIndex >= 0 ) {

				const b = this.hands[ this.secondHandIndex ];
				this.grabHandIndex = this.secondHandIndex;
				this.secondHandIndex = -1;
				if ( b && b.visible ) this.grab.dropSecondHand( b.pivot );

			} else {

				this.grab.release();
				this.grabHandIndex = -1;

			}

		}

	}

	_clearHand( i ) {

		this.hoverPerHand[ i ] = null;
		if ( i === this.grabHandIndex ) {

			this.grab.release();
			this.grabHandIndex = -1;
			this.secondHandIndex = -1;

		}
		if ( i === this.secondHandIndex ) this.secondHandIndex = -1;

	}

	_handOnMachine( i ) {

		const state = this.hands[ i ];
		if ( ! state || ! state.visible ) return false;
		return partsNearPoint( state.indexTip, this.assembly.parts, this.config.explodeLatchPad ).length > 0;

	}

	/* ------------------------------------------------------------------ *
	 * Exploded-view gesture
	 * ------------------------------------------------------------------ */

	_beginExplodeLatch( i, other ) {

		const a = this.hands[ i ].indexTip;
		const b = this.hands[ other ].indexTip;

		this.explodeLatch = true;
		this.explodeRestSpan = Math.max( a.distanceTo( b ), 0.02 );
		this.explodeAmount = 0;

		// Both hands are committed to the gesture, so nothing is held.
		if ( this.grab.isGrabbing ) {

			this.grab.release();
			this.grabHandIndex = -1;
			this.secondHandIndex = -1;

		}

		this.onExplodeLatch?.( true );
		this.onPulse?.( i, 0.4, 25 );
		this.onPulse?.( other, 0.4, 25 );

	}

	_endExplodeLatch() {

		this.explodeLatch = false;
		// Snap to the nearer end instead of leaving a half-exploded machine.
		this.explode.setExploded( this.explodeAmount > 0.5 );
		this.explode.release();
		this.onExplodeLatch?.( false );

	}

	_updateExplodeGesture() {

		if ( ! this.explodeLatch ) return;

		const hands = this.hands;
		const bothPinched = hands.every( ( h ) => h.visible && h.pinch.active );

		if ( ! bothPinched ) {

			this._endExplodeLatch();
			return;

		}

		const span = hands[ 0 ].indexTip.distanceTo( hands[ 1 ].indexTip );
		const pull = span - this.explodeRestSpan;

		this.explodeAmount = clamp(
			ramp( pull, this.config.explodePullStart, this.config.explodePullEnd ),
			0,
			1
		);

		this.explode.setAmount( this.explodeAmount );

	}

	/* ------------------------------------------------------------------ *
	 * External commands (HUD buttons, keyboard, XR trigger)
	 * ------------------------------------------------------------------ */

	toggleExplode() {

		if ( this.explodeLatch ) this._endExplodeLatch();
		const next = ! this.explode.isExploded;
		this.explode.setExploded( next );
		return next;

	}

	setExploded( on ) {

		if ( this.explodeLatch ) this._endExplodeLatch();
		this.explode.setExploded( !! on );
		return !! on;

	}

	/** Return every part home and cancel any grab. */
	reset() {

		this.grab.release();
		this.grabHandIndex = -1;
		this.secondHandIndex = -1;
		if ( this.explodeLatch ) this._endExplodeLatch();
		this.explode.reset();
		this.tooltip?.hide();

	}

	dispose() {

		this.grab.release();
		this.tooltip?.dispose?.();
		this.menu?.dispose?.();

	}

}
