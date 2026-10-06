/**
 * unit.test.mjs
 * ---------------------------------------------------------------------------
 * Headless checks for the logic that does not need a GPU.
 * Run: node tests/unit.test.mjs
 * ---------------------------------------------------------------------------
 */

import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';

import { clamp, damp, hysteresis, ramp, invLerp, easeOutCubic } from '../src/utils/mathUtils.js';
import { PinchDetector } from '../src/interaction/PinchDetector.js';
import { findNearestPart, partsNearPoint } from '../src/interaction/ProximitySensor.js';
import { ExplodeController } from '../src/machine/ExplodeController.js';
import { GrabController } from '../src/interaction/GrabController.js';
import { MachinePart } from '../src/machine/MachinePart.js';
import { buildPart } from '../src/machine/partFactory.js';
import { gearGeometry, boltRing, place } from '../src/machine/geometryKit.js';
import { mapLandmarksToJoints, estimateDepth, handQuaternion } from '../src/interaction/CameraHandProvider.js';

let passed = 0, failed = 0; const failures = [];
const check = ( name, cond, detail = '' ) => {

	if ( cond ) { passed ++; console.log( `  ✓ ${name}` ); }
	else { failed ++; failures.push( name ); console.log( `  ✗ ${name} ${detail}` ); }

};
const approx = ( a, b, eps = 1e-4 ) => Math.abs( a - b ) <= eps;

console.log( '\nunit tests\n' );

/* ------------------------------------------------------------------ *
 * mathUtils
 * ------------------------------------------------------------------ */

console.log( 'mathUtils' );
check( 'clamp bounds', clamp( 5, 0, 1 ) === 1 && clamp( - 3, 0, 1 ) === 0 && clamp( 0.5, 0, 1 ) === 0.5 );
check( 'damp is frame-rate independent over a fixed interval',
	( () => {

		let a = 0, b = 0;
		for ( let i = 0; i < 60; i ++ ) a = damp( a, 1, 8, 1 / 60 );     // 60 Hz
		for ( let i = 0; i < 30; i ++ ) b = damp( b, 1, 8, 1 / 30 );     // 30 Hz, same 1 s
		return approx( a, b, 0.02 );

	} )() );
check( 'hysteresis engages below, releases above, holds between',
	( () => {

		let s = false;
		s = hysteresis( 0.01, s, 0.02, 0.03 );   // engage
		if ( ! s ) return false;
		s = hysteresis( 0.025, s, 0.02, 0.03 );  // dead band: hold
		if ( ! s ) return false;
		s = hysteresis( 0.035, s, 0.02, 0.03 );   // release
		return s === false;

	} )() );
check( 'ramp dead-zone then saturate', ramp( 0.01, 0.05, 0.2 ) === 0 && ramp( 0.3, 0.05, 0.2 ) === 1 );
check( 'invLerp', approx( invLerp( 0, 10, 4 ), 0.4 ) );
check( 'easeOutCubic endpoints', approx( easeOutCubic( 0 ), 0 ) && approx( easeOutCubic( 1 ), 1 ) );

/* ------------------------------------------------------------------ *
 * PinchDetector
 * ------------------------------------------------------------------ */

console.log( 'PinchDetector' );
{

	const det = new PinchDetector( { engageDistance: 0.02, releaseDistance: 0.03 } );
	det.update( 0.05 );                 // apart
	check( 'starts open', det.active === false );
	det.update( 0.015 );               // close
	check( 'engages below threshold', det.active === true );
	det.update( 0.026 );               // in dead band -> stays engaged
	check( 'hysteresis holds in dead band', det.active === true );
	det.update( 0.04 );               // opens
	check( 'releases above threshold', det.active === false );

	// No jitter chatter: sweep across the engage threshold repeatedly.
	let toggles = 0;
	const d2 = new PinchDetector();
	d2.update( 0.05 );
	let prev = d2.active;
	for ( let i = 0; i < 40; i ++ ) {

		d2.update( 0.027 );   // dead band between engage(0.021) and release(0.033)
		if ( d2.active !== prev ) toggles ++;
		prev = d2.active;

	}
	check( 'no chatter for a value held in the dead band', toggles === 0 );

	const thrown = ( () => { try { new PinchDetector( { engageDistance: 0.05, releaseDistance: 0.02 } ); return false; } catch { return true; } } )();
	check( 'rejects inverted thresholds', thrown );

	// Fly-by rejection.
	const d3 = new PinchDetector( { maxGrabSpeed: 1 } );
	d3.update( 0.01, 10 );   // very fast, closed distance
	check( 'fast pass-by does not latch', d3.active === false );

}

/* ------------------------------------------------------------------ *
 * ProximitySensor
 * ------------------------------------------------------------------ */

console.log( 'ProximitySensor' );
{

	const makePart = ( id, x, r ) => {

		const part = { id, worldSphere: { center: new Vector3( x, 0, 0 ), radius: r } };
		return part;

	};
	const a = makePart( 'a', 0, 0.1 );
	const b = makePart( 'b', 0.5, 0.1 );

	const near = findNearestPart( new Vector3( 0.05, 0, 0 ), [ a, b ], { pad: 0.1 } );
	check( 'finds nearest part by surface gap', near.part.id === 'a' );

	const far = findNearestPart( new Vector3( 10, 0, 0 ), [ a, b ], { pad: 0.1 } );
	check( 'returns null outside the pad', far === null );

	// Bias keeps the current part when equidistant-ish.
	const biased = findNearestPart( new Vector3( 0.245, 0, 0 ), [ a, b ], { pad: 0.3, bias: 0.05, preferId: 'a' } );
	check( 'hysteresis bias prefers current part', biased.part.id === 'a' );

	const nearSet = partsNearPoint( new Vector3( 0.02, 0, 0 ), [ a, b ], 0.05 );
	check( 'partsNearPoint includes only close parts', nearSet.length === 1 && nearSet[ 0 ].id === 'a' );

}

/* ------------------------------------------------------------------ *
 * ExplodeController
 * ------------------------------------------------------------------ */

console.log( 'ExplodeController' );
{

	const parent = new Group();
	const mk = ( id, dir, dist, delay = 0 ) => buildPart( {
		id, name: id, meta: { partNo: id }, explodeDir: dir, explodeDistance: dist, explodeDelay: delay,
		meshes: [ new Mesh( new BoxGeometry( 0.1, 0.1, 0.1 ), new MeshStandardMaterial() ) ],
	} );

	const p1 = mk( 'p1', [ 1, 0, 0 ], 0.2 );
	const p2 = mk( 'p2', [ 0, 1, 0 ], 0.4, 0.5 );
	parent.add( p1.group, p2.group );
	parent.updateMatrixWorld( true );

	const ctrl = new ExplodeController( [ p1, p2 ], { lambda: 50 } );
	ctrl.setExploded( true );
	for ( let i = 0; i < 120; i ++ ) ctrl.update( 1 / 60 );

	check( 'part without delay reaches full distance', approx( p1.group.position.x, 0.2, 1e-3 ), p1.group.position.x );
	check( 'delayed part also reaches full distance', approx( p2.group.position.y, 0.4, 1e-3 ), p2.group.position.y );

	ctrl.reset();
	check( 'reset returns parts home', p1.group.position.length() < 1e-6 && p2.group.position.length() < 1e-6 );

	// Grabbed parts are skipped.
	ctrl.setExploded( true );
	p1.grabbed = true;
	const before = p1.group.position.clone();
	for ( let i = 0; i < 60; i ++ ) ctrl.update( 1 / 60 );
	check( 'grabbed part is not driven by the explode animation', p1.group.position.equals( before ) );

}

/* ------------------------------------------------------------------ *
 * GrabController
 * ------------------------------------------------------------------ */

console.log( 'GrabController' );
{

	const parent = new Group();
	const part = buildPart( {
		id: 'g', name: 'g', meta: { partNo: 'g' }, explodeDir: [ 0, 1, 0 ], explodeDistance: 0.2,
		meshes: [ new Mesh( new BoxGeometry( 0.1, 0.1, 0.1 ), new MeshStandardMaterial() ) ],
	} );
	part.group.position.set( 0, 0, 0 );
	parent.add( part.group );
	parent.updateMatrixWorld( true );

	const grab = new GrabController( { positionLambda: 60, rotationLambda: 60, leashDistance: 10 } );
	const pivot = { position: new Vector3( 0, 0.1, 0 ), quaternion: new Quaternion() };

	grab.attach( part, pivot, parent );
	for ( let i = 0; i < 30; i ++ ) grab.update( pivot, null, 1 / 60 );
	check( 'attach causes no jump (part stays at home)', part.group.position.length() < 0.01, part.group.position.length() );

	// Move the hand; the part must follow ~1:1.
	// At grab the part sat 0.1 m below the pivot, so after the hand moves to
	// (0.3,0.4,0) the part must sit 0.1 below it: rigid-body offset preserved.
	pivot.position.set( 0.3, 0.4, 0 );
	for ( let i = 0; i < 120; i ++ ) grab.update( pivot, null, 1 / 60 );
	check( 'part keeps its grab offset while following the hand', part.group.position.distanceTo( new Vector3( 0.3, 0.3, 0 ) ) < 0.02, part.group.position.toArray() );

	// Rotate the hand; the part attitude must follow.
	const q = new Quaternion().setFromAxisAngle( new Vector3( 0, 0, 1 ), Math.PI / 2 );
	pivot.quaternion.copy( q );
	for ( let i = 0; i < 120; i ++ ) grab.update( pivot, null, 1 / 60 );
	const wq = part.group.getWorldQuaternion( new Quaternion() );
	check( 'part rotates with the hand', Math.abs( Math.abs( wq.z ) - Math.sin( Math.PI / 4 ) ) < 0.05, wq.z );

	check( 'release detaches', grab.release() === part && grab.isGrabbing === false );

}

/* ------------------------------------------------------------------ *
 * geometry / part invariants
 * ------------------------------------------------------------------ */

console.log( 'geometry & part invariants' );
{

	const gearSolid = gearGeometry( { teeth: 12, outerRadius: 0.05, rootRadius: 0.04, thickness: 0.02 } );
	const gearBored = gearGeometry( { teeth: 12, outerRadius: 0.05, rootRadius: 0.04, thickness: 0.02, boreRadius: 0.015 } );
	check( 'bore adds an inner contour (more vertices than a solid disc)', gearBored.attributes.position.count > gearSolid.attributes.position.count );

	const ring = boltRing( { angles: [ 0, Math.PI / 2, Math.PI, 3 * Math.PI / 2 ], radius: 0.1, axis: 'x' } );
	check( 'bolt ring merges 4 bolts into one geometry', ring.attributes.position.count > 0 && ring.index !== null );

	const part = buildPart( {
		id: 'inv', name: 'inv', meta: { partNo: 'inv' }, explodeDir: [ 2, 0, 0 ], explodeDistance: 0.3,
		meshes: [ new Mesh( new BoxGeometry( 0.1, 0.1, 0.1 ), new MeshStandardMaterial() ) ],
	} );
	check( 'explode dir is normalised on construct', approx( part.explodeDir.length(), 1 ) );
	check( 'local bounding sphere is finite and positive', isFinite( part.localSphere.radius ) && part.localSphere.radius > 0 );

	part.setHighlight( 5 );   // out of range must clamp, not blow up
	check( 'highlight clamps to [0,1]', part.highlight <= 1 );
	part.setHighlight( - 2 );
	check( 'highlight clamps low', part.highlight >= 0 );

	// place() bakes a translation.
	const moved = place( new BoxGeometry( 1, 1, 1 ), { x: 3, y: 0, z: 0 } );
	moved.computeBoundingBox();
	check( 'place() translates baked geometry', approx( moved.boundingBox.getCenter( new Vector3() ).x, 3 ) );

}

/* ------------------------------------------------------------------ *
 * CameraHandProvider landmark math
 * ------------------------------------------------------------------ */

console.log( 'CameraHandProvider mapping' );
{

	// Synthetic open hand: fingers along +Z, spread on X, MediaPipe order.
	const fingers = [
		[ 0.04, 5, 8 ],    // thumb-ish offset handled separately below
	];
	const wl = [];
	wl[ 0 ] = { x: 0, y: 0, z: 0 };                                   // wrist
	// thumb
	wl[ 1 ] = { x: 0.03, y: 0.00, z: 0.01 };
	wl[ 2 ] = { x: 0.045, y: 0.00, z: 0.02 };
	wl[ 3 ] = { x: 0.055, y: 0.00, z: 0.035 };
	wl[ 4 ] = { x: 0.06, y: 0.00, z: 0.05 };                          // thumb tip
	const xs = [ 0.02, 0.0, - 0.02, - 0.04 ];
	for ( let f = 0; f < 4; f ++ ) {

		const base = 5 + f * 4;
		wl[ base ] = { x: xs[ f ], y: 0, z: 0.02 };                   // MCP
		wl[ base + 1 ] = { x: xs[ f ], y: 0, z: 0.05 };               // PIP
		wl[ base + 2 ] = { x: xs[ f ], y: 0, z: 0.075 };              // DIP
		wl[ base + 3 ] = { x: xs[ f ], y: 0, z: 0.095 };              // tip

	}

	const joints = mapLandmarksToJoints( wl, false );
	check( 'maps all 25 XR joints', joints.size === 25, joints.size );
	check( 'index tip equals landmark 8', joints.get( 'index-finger-tip' ).distanceTo( new Vector3( 0.02, 0, 0.095 ) ) < 1e-9 );
	const im = joints.get( 'index-finger-metacarpal' );
	check( 'synthesised metacarpal is wrist/MCP midpoint', Math.abs( im.x - 0.01 ) < 1e-9 && Math.abs( im.z - 0.01 ) < 1e-9 );

	const mirrored = mapLandmarksToJoints( wl, true );
	check( 'mirror flips X for every joint',
		[ ...joints.entries() ].every( ( [ name, p ] ) =>
			Math.abs( p.x + mirrored.get( name ).x ) < 1e-9 ) );

	// Depth: choose an apparent size consistent with 0.6 m and recover it.
	const fovY = 55 * Math.PI / 180;
	const focal = 1 / Math.tan( fovY / 2 );
	const metric = 0.02;   // synthetic wrist -> middle-MCP distance
	const want = 0.6;
	const ndcSpan = ( metric * focal ) / want;      // what the provider expects
	const lm = wl.map( ( p ) => ( { x: 0.5, y: 0.5 } ) );
	lm[ 0 ].y = 0.5 - ndcSpan / 4;                  // normalised diff = ndcSpan/2
	lm[ 9 ].y = 0.5 + ndcSpan / 4;
	const depth = estimateDepth( lm, wl, fovY );
	check( 'monocular depth estimate recovers distance', Math.abs( depth - want ) < 0.01, depth );

	const q = handQuaternion( wl, false );
	check( 'hand attitude is a unit quaternion', Math.abs( q.length() - 1 ) < 1e-6 );

	void fingers;

}

console.log( `\n${passed} passed, ${failed} failed` );
if ( failures.length ) console.log( 'failures:', failures.join( ', ' ) );
process.exit( failed > 0 ? 1 : 0 );
