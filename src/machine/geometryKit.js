/**
 * geometryKit.js
 * ---------------------------------------------------------------------------
 * Small procedural-geometry helpers. Everything here is built once at load
 * time of an assembly (never per frame) and merged wherever possible so a part
 * made of 24 bolts is still a single draw call.
 * ---------------------------------------------------------------------------
 */

import {
	CylinderGeometry,
	ExtrudeGeometry,
	Path,
	Shape,
	Vector3,
	Matrix4,
	Quaternion,
	Euler,
} from 'three';

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _m = /* @__PURE__ */ new Matrix4();
const _q = /* @__PURE__ */ new Quaternion();
const _e = /* @__PURE__ */ new Euler();
const _p = /* @__PURE__ */ new Vector3();
const _s = /* @__PURE__ */ new Vector3( 1, 1, 1 );

/**
 * Bake a transform into a geometry. Baking (instead of parenting) keeps the
 * scene graph flat: fewer matrix updates and fewer draw calls.
 */
export function place( geometry, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {} ) {

	_e.set( rx, ry, rz );
	_q.setFromEuler( _e );
	_p.set( x, y, z );
	_m.compose( _p, _q, _s.set( sx, sy, sz ) );

	return geometry.applyMatrix4( _m );

}

/**
 * Three's cylinders and lathes are authored around +Y. Machine assemblies in
 * this project run along +X, so this rotates a geometry a quarter turn about Z
 * (+Y -> +X) and bakes it in.
 */
export function alignToX( geometry ) {

	return geometry.rotateZ( - Math.PI / 2 );

}

/** Hex head (6 radial segments) — reads as a bolt head at any distance. */
export function hexHead( radius, height, segments = 6 ) {

	return new CylinderGeometry( radius, radius, height, segments );

}

/**
 * A set of bolts merged into one geometry (one draw call per bolt group).
 *
 * Angles are measured in the plane perpendicular to the bolt axis, with 0 rad on
 * +Y — matching how a split-flange drawing is read.
 *
 * @param {Object}   o
 * @param {number[]} [o.angles]      Explicit bolt angles in radians.
 * @param {number}   [o.count]       Evenly spaced bolts (used if `angles` is absent).
 * @param {number}   [o.startAngle]  Phase offset for `count`.
 * @param {number}   o.radius        Pitch-circle radius.
 * @param {number}  [o.headRadius]   Hex head circumradius.
 * @param {number}  [o.headHeight]
 * @param {number}  [o.shankRadius]
 * @param {number}  [o.shankHeight]
 * @param {'x'|'y'} [o.axis]         Bolt axis.
 */
export function boltRing( {
	angles,
	count,
	startAngle = 0,
	radius,
	headRadius = 0.011,
	headHeight = 0.008,
	shankRadius = 0.006,
	shankHeight = 0.02,
	axis = 'x',
} = {} ) {

	const list = angles ?? Array.from(
		{ length: count ?? 6 },
		( _, i ) => startAngle + ( i / ( count ?? 6 ) ) * Math.PI * 2
	);

	const parts = [];

	for ( const a of list ) {

		// Angle 0 points at +Y, so cos drives the vertical offset.
		const cy = Math.cos( a ) * radius;
		const cz = Math.sin( a ) * radius;

		if ( axis === 'x' ) {

			parts.push( place( hexHead( headRadius, headHeight ), { x: shankHeight * 0.5, y: cy, z: cz, rz: - Math.PI / 2 } ) );
			parts.push( place( new CylinderGeometry( shankRadius, shankRadius, shankHeight, 8 ), { x: 0, y: cy, z: cz, rz: - Math.PI / 2 } ) );

		} else {

			parts.push( place( hexHead( headRadius, headHeight ), { x: cz, y: shankHeight * 0.5, z: cy } ) );
			parts.push( place( new CylinderGeometry( shankRadius, shankRadius, shankHeight, 8 ), { x: cz, y: 0, z: cy } ) );

		}

	}

	return mergeGeometries( parts, false );

}

/**
 * Spur-gear profile as an extruded shape. Used by the planetary gearbox.
 * Teeth are trapezoidal: root fillet -> tip land -> root fillet.
 */
export function gearGeometry( {
	teeth = 24,
	outerRadius = 0.1,
	rootRadius = 0.088,
	thickness = 0.03,
	boreRadius = 0,
	bevel = 0.0015,
} = {} ) {

	const shape = new Shape();
	const step = ( Math.PI * 2 ) / teeth;

	const point = ( r, a ) => [ Math.cos( a ) * r, Math.sin( a ) * r ];

	for ( let i = 0; i < teeth; i ++ ) {

		const a = i * step;
		const p0 = point( rootRadius, a );
		const p1 = point( rootRadius, a + step * 0.20 );
		const p2 = point( outerRadius, a + step * 0.30 );
		const p3 = point( outerRadius, a + step * 0.70 );
		const p4 = point( rootRadius, a + step * 0.80 );

		if ( i === 0 ) shape.moveTo( p0[ 0 ], p0[ 1 ] );
		else shape.lineTo( p0[ 0 ], p0[ 1 ] );

		shape.lineTo( p1[ 0 ], p1[ 1 ] );
		shape.lineTo( p2[ 0 ], p2[ 1 ] );
		shape.lineTo( p3[ 0 ], p3[ 1 ] );
		shape.lineTo( p4[ 0 ], p4[ 1 ] );

	}
	shape.closePath();

	if ( boreRadius > 0 ) {

		// Holes must wind opposite to the outer contour, hence clockwise = true.
		const bore = new Path();
		bore.absarc( 0, 0, boreRadius, 0, Math.PI * 2, true );
		shape.holes.push( bore );

	}

	const geometry = new ExtrudeGeometry( shape, {
		depth: thickness,
		bevelEnabled: bevel > 0,
		bevelThickness: bevel,
		bevelSize: bevel,
		bevelSegments: 1,
		curveSegments: 6,
	} );

	geometry.translate( 0, 0, - thickness / 2 );
	geometry.computeVertexNormals();

	return geometry;

}
