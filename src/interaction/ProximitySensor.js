/**
 * ProximitySensor.js
 * ---------------------------------------------------------------------------
 * "Is a fingertip close to a component?"
 *
 * Deliberately NOT a raycast. Raycasting the full tessellated assembly every
 * frame for both hands is the single easiest way to lose your frame budget in
 * a headset; and a ray is the wrong metaphor anyway — hand interaction is about
 * *nearness*, not about pointing. A sphere test is one subtraction and one
 * length per part, so eight parts cost effectively nothing and the highlight
 * feels volumetric: the glow fades in as your finger approaches instead of
 * snapping on when an invisible line happens to cross a triangle.
 *
 * The bounding spheres are cached per part at build time (MachinePart
 * .localSphere) and re-projected into world space once per frame.
 * ---------------------------------------------------------------------------
 */

import { Raycaster, Vector3 } from 'three';

const _delta = /* @__PURE__ */ new Vector3();

/**
 * Find the component closest to `point`.
 *
 * @param {Vector3} point  Fingertip (or any probe) in world space.
 * @param {import('../machine/MachinePart.js').MachinePart[]} parts
 * @param {Object} [opts]
 * @param {number} [opts.pad]       Extra reach beyond the bounding sphere, metres.
 * @param {number} [opts.bias]      Prefer parts already hovered, to stop flicker
 *                                  between two touching components. Metres of slack.
 * @param {string} [opts.preferId]  id of the currently hovered part.
 * @returns {?{part: Object, gap: number, proximity: number}}
 *          gap        signed distance from the fingertip to the part surface
 *          proximity  1 at contact, 0 at the edge of `pad`
 */
export function findNearestPart( point, parts, { pad = 0.025, bias = 0.012, preferId = null } = {} ) {

	let best = null;
	let bestGap = Infinity;

	for ( let i = 0; i < parts.length; i ++ ) {

		const part = parts[ i ];
		const sphere = part.worldSphere;

		_delta.subVectors( point, sphere.center );
		// Surface gap: negative means the fingertip is inside the bounding volume.
		let gap = _delta.length() - sphere.radius;

		// Hysteresis against flicker: the part already under the finger gets a
		// small advantage, so two adjacent components cannot trade the highlight
		// every frame while a hand rests on their shared edge.
		if ( preferId && part.id === preferId ) gap -= bias;

		if ( gap < pad && gap < bestGap ) {

			bestGap = gap;
			best = part;

		}

	}

	if ( ! best ) return null;

	return {
		part: best,
		gap: bestGap,
		proximity: Math.min( 1, Math.max( 0, 1 - Math.max( 0, bestGap ) / Math.max( pad, 1e-6 ) ) ),
	};

}

/**
 * Resolve which component a hand is actually touching.
 *
 * Two phases, because each alone is wrong:
 *
 *   broad  (spheres)  cheap, volumetric, and gives the "reach" test — but a
 *                     bounding sphere is a poor fit for a long thin rod, and it
 *                     cannot see that a piston is ENCLOSED by its housing. Pure
 *                     sphere tests would highlight the housing whenever you
 *                     point anywhere near the machine.
 *
 *   narrow (raycast)  exact — the first surface along the wrist→fingertip ray
 *                     is the component under the finger, which is what a person
 *                     means by "touching". Run only against the handful of
 *                     parts the broad phase already shortlisted, so the cost is
 *                     a few meshes rather than the whole assembly.
 *
 * If the narrow phase misses (finger beside a part rather than on it) the broad
 * result is kept, so the highlight still fades in on approach.
 *
 * @param {import('./HandState.js').HandState} hand
 * @param {import('../machine/MachinePart.js').MachinePart[]} parts
 * @param {Object} [opts]
 * @param {number} [opts.pad]
 * @param {number} [opts.bias]
 * @param {string} [opts.preferId]
 * @param {number} [opts.narrowPad] Extra reach for the raycast shortlist.
 * @param {Raycaster} [opts.raycaster]
 * @returns {?{part: Object, gap: number, proximity: number, precise: boolean}}
 */
export function resolveHover( hand, parts, {
	pad = 0.028,
	bias = 0.014,
	preferId = null,
	narrowPad = 0.06,
	raycaster = null,
} = {} ) {

	const broad = findNearestPart( hand.indexTip, parts, { pad, bias, preferId } );
	if ( ! broad ) return null;

	const caster = raycaster ?? _sharedRaycaster;

	// Aim the ray along the hand's pointing direction, from just behind the
	// wrist to just past the fingertip.
	_rayOrigin.copy( hand.wrist );
	_rayDir.subVectors( hand.indexTip, hand.wrist );
	const reach = _rayDir.length();
	if ( reach < 1e-5 ) return { ...broad, precise: false };
	_rayDir.divideScalar( reach );

	caster.set( _rayOrigin, _rayDir );
	caster.near = 0;
	caster.far = reach + pad + 0.03;

	// Shortlist: only parts whose bounding volume is anywhere near the finger.
	_shortlist.length = 0;
	for ( const part of parts ) {

		_delta.subVectors( hand.indexTip, part.worldSphere.center );
		if ( _delta.length() - part.worldSphere.radius < narrowPad ) _shortlist.push( part );

	}

	if ( _shortlist.length === 0 ) return { ...broad, precise: false };

	_targets.length = 0;
	for ( const part of _shortlist ) {

		for ( const mesh of part.meshes ) _targets.push( mesh );

	}

	const hits = caster.intersectObjects( _targets, false );

	if ( hits.length > 0 ) {

		// Meshes carry no part reference of their own, so walk up to the group
		// that MachinePart stamped with `userData.partId`.
		let node = hits[ 0 ].object;
		while ( node && ! node.userData.partId ) node = node.parent;

		const part = node ? parts.find( ( p ) => p.id === node.userData.partId ) : null;
		if ( part ) {

			return { part, gap: 0, proximity: 1, precise: true };

		}

	}

	return { ...broad, precise: false };

}

const _shortlist = [];
const _targets = [];
const _rayOrigin = /* @__PURE__ */ new Vector3();
const _rayDir = /* @__PURE__ */ new Vector3();
const _sharedRaycaster = /* @__PURE__ */ new Raycaster();

/**
 * Parts whose bounding sphere contains / nearly contains `point`.
 * Used by the two-hand exploded-view gesture to decide whether both hands are
 * actually "on" the machine before the pull-apart is honoured.
 *
 * @returns {import('../machine/MachinePart.js').MachinePart[]}
 */
export function partsNearPoint( point, parts, pad = 0.04 ) {

	const out = [];

	for ( const part of parts ) {

		_delta.subVectors( point, part.worldSphere.center );
		if ( _delta.length() - part.worldSphere.radius < pad ) out.push( part );

	}

	return out;

}
