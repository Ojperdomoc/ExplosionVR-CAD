/**
 * mathUtils.js
 * ---------------------------------------------------------------------------
 * Frame-rate independent smoothing helpers.
 *
 * Every interactive value in this app (hover glow, tooltip position, exploded
 * view, grabbed part transform) is driven by exponential damping rather than a
 * tween library. Damping is:
 *
 *   1. frame-rate independent  -> identical feel at 72 Hz (Quest) and 144 Hz
 *   2. allocation free         -> no GC pressure inside the XR frame loop
 *   3. one line to reason about
 *
 * The exponential factor `1 - exp(-lambda * dt)` is the exact solution of
 * `dx/dt = -lambda * (x - target)`, which is why it does not drift with dt the
 * way a naive `lerp(a, b, 0.1)` does.
 * ---------------------------------------------------------------------------
 */

export const clamp = ( v, min, max ) => ( v < min ? min : v > max ? max : v );

export const invLerp = ( a, b, v ) => ( b === a ? 0 : ( v - a ) / ( b - a ) );

export const lerp = ( a, b, t ) => a + ( b - a ) * t;

/** Remap `v` from [a,b] into [0,1], clamped. */
export const saturateRange = ( v, a, b ) => clamp( invLerp( a, b, v ), 0, 1 );

export const easeOutCubic = ( t ) => 1 - Math.pow( 1 - t, 3 );

export const easeInOutCubic = ( t ) =>
	t < 0.5 ? 4 * t * t * t : 1 - Math.pow( - 2 * t + 2, 3 ) / 2;

export const easeOutBack = ( t ) => {
	const c1 = 1.70158;
	const c3 = c1 + 1;
	return 1 + c3 * Math.pow( t - 1, 3 ) + c1 * Math.pow( t - 1, 2 );
};

/**
 * Frame-rate independent exponential approach.
 *
 * @param {number} current
 * @param {number} target
 * @param {number} lambda  Response speed. ~6 is a slow UI fade, ~18 a snappy grab.
 * @param {number} dt      Delta time in seconds (clamped by the caller).
 * @returns {number}
 */
export const damp = ( current, target, lambda, dt ) =>
	lerp( current, target, 1 - Math.exp( - lambda * dt ) );

/**
 * Shortest-path angular damping (radians). Uses the (-PI, PI] wrap so the value
 * never spins the long way round.
 */
export const dampAngle = ( current, target, lambda, dt ) => {
	let delta = ( target - current ) % ( Math.PI * 2 );
	if ( delta > Math.PI ) delta -= Math.PI * 2;
	if ( delta < - Math.PI ) delta += Math.PI * 2;
	return current + delta * ( 1 - Math.exp( - lambda * dt ) );
};

/**
 * Trigger-with-hysteresis. Prevents the "stutter" you get from comparing a
 * noisy sensor value (hand tracking jitter is typically 1-3 mm) against a
 * single threshold: the value would flicker in and out of range every frame.
 *
 *   engage at `current <= onBelow`
 *   release at `current >= offAbove`      (offAbove must be > onBelow)
 *
 * @param {number} current  Measured distance.
 * @param {boolean} state   Previous state.
 * @param {number} onBelow  Engage threshold.
 * @param {number} offAbove Release threshold.
 * @returns {boolean} New state.
 */
export const hysteresis = ( current, state, onBelow, offAbove ) =>
	state ? current < offAbove : current <= onBelow;

/** Dead-zone + normalise: returns 0 inside `lo`, 1 above `hi`. */
export const ramp = ( v, lo, hi ) => saturateRange( v, lo, hi );

/**
 * Deterministic pseudo random in [-1, 1] from an integer seed. Used to jitter
 * bolt placement so the assembly does not look machine-perfect while still
 * being reproducible across reloads (important for visual regression tests).
 */
export const seededUnit = ( seed ) => {
	const x = Math.sin( seed * 127.1 + 311.7 ) * 43758.5453;
	return ( x - Math.floor( x ) ) * 2 - 1;
};
