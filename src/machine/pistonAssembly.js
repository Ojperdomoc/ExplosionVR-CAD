/**
 * pistonAssembly.js
 * ---------------------------------------------------------------------------
 * Procedural "HX-2500" double-acting hydraulic piston assembly.
 *
 * Why procedural instead of a GLTF?
 *   - zero network payload, no loader/DRACO/KTX2 pipeline to babysit
 *   - every sub-mesh is authored in the same units as the specs it displays
 *   - swap in a real CAD export later: keep the MachinePart contract and the
 *     interaction layer does not change (see AssemblyRegistry.js)
 *
 * Conventions
 *   - assembly axis is +X, bore centre line is y = 0, z = 0
 *   - all dimensions in metres
 *   - each returned MachinePart group is re-centred on its own centroid, so a
 *     hand that grabs and twists a part rotates it about itself
 * ---------------------------------------------------------------------------
 */

import {
	BoxGeometry,
	CylinderGeometry,
	DoubleSide,
	Group,
	LatheGeometry,
	Mesh,
	MeshStandardMaterial,
	SphereGeometry,
	TorusGeometry,
	Vector2,
	Vector3,
} from 'three';

import { boltRing } from './geometryKit.js';
import { buildPart } from './partFactory.js';

/* ---------------------------------------------------------------- *
 * Material palette — industrial metals under an HDRI environment
 * ---------------------------------------------------------------- */

const metal = ( color, metalness = 0.9, roughness = 0.35, extra ) =>
	new MeshStandardMaterial( { color, metalness, roughness, envMapIntensity: 1.2, ...extra } );

const MAT = {
	anodised:   () => metal( 0x4a5057, 0.86, 0.42, { side: DoubleSide } ),
	castIron:   () => metal( 0x5b6169, 0.72, 0.55 ),
	steel:      () => metal( 0x9aa1a9, 0.95, 0.26 ),
	chrome:     () => metal( 0xd6dce2, 1.00, 0.07 ),
	forged:     () => metal( 0x767d85, 0.92, 0.35 ),
	brass:      () => metal( 0xc2a05a, 1.00, 0.28 ),
	bolt:       () => metal( 0x2f343a, 0.90, 0.48 ),
	rubber:     () => metal( 0x15171b, 0.05, 0.82 ),
	ptfe:       () => metal( 0xb9a06a, 0.35, 0.55 ),
	polymer:    () => metal( 0xd1481f, 0.10, 0.55 ),
};

/* ---------------------------------------------------------------- *
 * Small authoring helpers
 * ---------------------------------------------------------------- */

const X_AXIS = - Math.PI / 2; // rotates a +Y primitive onto +X
const profile = ( pts ) => pts.map( ( [ x, y ] ) => new Vector2( x, y ) );

/** Create a mesh already positioned/rotated in ASSEMBLY space. */
function m( geometry, material, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {} ) {

	const mesh = new Mesh( geometry, material );
	mesh.position.set( x, y, z );
	mesh.rotation.set( rx, ry, rz );
	if ( sx !== 1 || sy !== 1 || sz !== 1 ) mesh.scale.set( sx, sy, sz );
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	return mesh;

}

/* ---------------------------------------------------------------- *
 * Geometry profiles
 * ---------------------------------------------------------------- */

// Hollow bore tube cross-section: outer wall -> end face -> inner wall -> back.
const TUBE_PROFILE = profile( [
	[ 0.085, - 0.170 ], [ 0.085, 0.170 ], [ 0.072, 0.170 ], [ 0.072, - 0.170 ], [ 0.085, - 0.170 ],
] );

// Piston crown -> ring lands -> two ring grooves -> skirt.
const PISTON_PROFILE = profile( [
	[ 0.0000, 0.0500 ], [ 0.0400, 0.0500 ], [ 0.0620, 0.0480 ], [ 0.0735, 0.0430 ],
	[ 0.0735, 0.0300 ], [ 0.0680, 0.0280 ], [ 0.0680, 0.0200 ], [ 0.0735, 0.0180 ],
	[ 0.0735, 0.0020 ], [ 0.0680, 0.0000 ], [ 0.0680, - 0.0080 ], [ 0.0735, - 0.0100 ],
	[ 0.0735, - 0.0400 ], [ 0.0600, - 0.0480 ], [ 0.0400, - 0.0520 ], [ 0.0000, - 0.0520 ],
] );

// Rod gland bushing cross-section.
const GLAND_PROFILE = profile( [
	[ 0.0720, - 0.0250 ], [ 0.0720, 0.0250 ], [ 0.0560, 0.0250 ], [ 0.0560, - 0.0250 ], [ 0.0720, - 0.0250 ],
] );

const FLANGE_ANGLES_UPPER = [ - 62, - 22, 22, 62 ].map( ( d ) => d * Math.PI / 180 );
const FLANGE_ANGLES_LOWER = [ 118, 158, 202, 242 ].map( ( d ) => d * Math.PI / 180 );

const boltSet = ( angles ) => boltRing( {
	angles,
	radius: 0.0945,
	headRadius: 0.0095,
	headHeight: 0.009,
	shankRadius: 0.0055,
	shankHeight: 0.030,
	axis: 'x',
} );

/* ---------------------------------------------------------------- *
 * Assembly
 * ---------------------------------------------------------------- */

export function createPistonAssembly() {

	const parts = [];

	/* --- 1. Bore housing, upper half ----------------------------- */
	parts.push( buildPart( {
		id: 'housing-upper',
		name: 'Bore Housing — Upper Half',
		explodeDir: [ 0, 1, 0 ],
		explodeDistance: 0.26,
		explodeDelay: 0.08,
		meta: {
			partNo: 'HX2500-101',
			material: 'A356-T6 cast aluminium, hard anodised',
			mass: '3.8 kg',
			specs: [
				[ 'Bore', 'Ø 85.0 mm' ],
				[ 'Working pressure', '2 500 psi' ],
				[ 'Wall thickness', '13 mm' ],
				[ 'Fasteners', '8 × M10 × 1.25' ],
			],
			description: 'Split bore housing. Carries the piston seal land and the upper half of the split flange.',
		},
		meshes: [
			m( new LatheGeometry( TUBE_PROFILE, 56, Math.PI, Math.PI ), MAT.anodised(), { rz: X_AXIS } ),
			m( new CylinderGeometry( 0.104, 0.104, 0.014, 56, 1, false, Math.PI, Math.PI ), MAT.anodised(), { x: 0.155, rz: X_AXIS } ),
			m( new CylinderGeometry( 0.104, 0.104, 0.014, 56, 1, false, Math.PI, Math.PI ), MAT.anodised(), { x: - 0.155, rz: X_AXIS } ),
			m( boltSet( FLANGE_ANGLES_UPPER ), MAT.bolt(), { x: 0.155, ry: Math.PI } ),
			m( boltSet( FLANGE_ANGLES_UPPER ), MAT.bolt(), { x: - 0.155 } ),
		],
	} ) );

	/* --- 2. Bore housing, lower half ----------------------------- */
	parts.push( buildPart( {
		id: 'housing-lower',
		name: 'Bore Housing — Lower Half',
		explodeDir: [ 0, - 1, 0 ],
		explodeDistance: 0.17,
		explodeDelay: 0.16,
		meta: {
			partNo: 'HX2500-102',
			material: 'A356-T6 cast aluminium, hard anodised',
			mass: '4.1 kg',
			specs: [
				[ 'Bore', 'Ø 85.0 mm' ],
				[ 'Mounting', '2 × Ø 12 mm foot slots' ],
				[ 'Flatness', '0.02 mm over 340 mm' ],
			],
			description: 'Lower half of the split housing, with integrated foot mounts for frame bolting.',
		},
		meshes: [
			m( new LatheGeometry( TUBE_PROFILE, 56, 0, Math.PI ), MAT.anodised(), { rz: X_AXIS } ),
			m( new CylinderGeometry( 0.104, 0.104, 0.014, 56, 1, false, 0, Math.PI ), MAT.anodised(), { x: 0.155, rz: X_AXIS } ),
			m( new CylinderGeometry( 0.104, 0.104, 0.014, 56, 1, false, 0, Math.PI ), MAT.anodised(), { x: - 0.155, rz: X_AXIS } ),
			m( boltSet( FLANGE_ANGLES_LOWER ), MAT.bolt(), { x: 0.155, ry: Math.PI } ),
			m( boltSet( FLANGE_ANGLES_LOWER ), MAT.bolt(), { x: - 0.155 } ),
			m( new BoxGeometry( 0.11, 0.022, 0.055 ), MAT.anodised(), { x: 0.09, y: - 0.092 } ),
			m( new BoxGeometry( 0.11, 0.022, 0.055 ), MAT.anodised(), { x: - 0.09, y: - 0.092 } ),
		],
	} ) );

	/* --- 3. Rear end cap ----------------------------------------- */
	parts.push( buildPart( {
		id: 'end-cap',
		name: 'Rear End Cap & Port Block',
		explodeDir: [ - 1, 0.06, 0 ],
		explodeDistance: 0.30,
		explodeDelay: 0.02,
		meta: {
			partNo: 'HX2500-110',
			material: 'Ductile iron GGG-50',
			mass: '2.4 kg',
			specs: [
				[ 'Service port', 'G 1/2" BSP' ],
				[ 'Max flow', '120 L/min' ],
				[ 'Burst pressure', '7 500 psi' ],
			],
			description: 'Pressure-containing end closure with the rear service port and integrated cushion sleeve.',
		},
		meshes: [
			m( new CylinderGeometry( 0.104, 0.104, 0.026, 56 ), MAT.castIron(), { x: - 0.183, rz: X_AXIS } ),
			m( new SphereGeometry( 0.085, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2 ), MAT.castIron(), { x: - 0.196, rz: Math.PI / 2, sx: 0.45 } ),
			m( new TorusGeometry( 0.095, 0.008, 10, 48 ), MAT.castIron(), { x: - 0.170, ry: Math.PI / 2 } ),
			m( new CylinderGeometry( 0.021, 0.021, 0.052, 24 ), MAT.castIron(), { x: - 0.176, y: 0.10 } ),
			m( new CylinderGeometry( 0.028, 0.028, 0.013, 6 ), MAT.bolt(), { x: - 0.176, y: 0.130 } ),
		],
	} ) );

	/* --- 4. Piston head ------------------------------------------ */
	parts.push( buildPart( {
		id: 'piston',
		name: 'Piston Head Assembly',
		explodeDir: [ - 0.5, 0.55, 0 ],
		explodeDistance: 0.30,
		explodeDelay: 0.22,
		accent: 0x46d3ff,
		meta: {
			partNo: 'HX2500-120',
			material: '42CrMo4 quenched & tempered steel',
			mass: '1.9 kg',
			specs: [
				[ 'Diameter', 'Ø 84.94 mm' ],
				[ 'Pressure', '2 500 psi' ],
				[ 'Thrust rating', '14.7 kN' ],
				[ 'Rings', '2 × PTFE + NBR energiser' ],
			],
			description: 'Double-acting piston. Converts fluid pressure into linear thrust; the two PTFE bands carry the side load.',
		},
		meshes: [
			m( new LatheGeometry( PISTON_PROFILE, 56 ), MAT.steel(), { x: - 0.040, rz: X_AXIS } ),
			m( new TorusGeometry( 0.0705, 0.0058, 12, 48 ), MAT.ptfe(), { x: - 0.016, ry: Math.PI / 2 } ),
			m( new TorusGeometry( 0.0705, 0.0058, 12, 48 ), MAT.ptfe(), { x: - 0.044, ry: Math.PI / 2 } ),
			m( new CylinderGeometry( 0.030, 0.030, 0.104, 28 ), MAT.steel(), { x: - 0.040, rz: X_AXIS } ),
		],
	} ) );

	/* --- 5. Rod seal pack ---------------------------------------- */
	parts.push( buildPart( {
		id: 'seals',
		name: 'Rod Seal & Wiper Pack',
		explodeDir: [ 0.30, 0.72, 0.30 ],
		explodeDistance: 0.26,
		explodeDelay: 0.12,
		accent: 0x6dffa8,
		meta: {
			partNo: 'HX2500-130',
			material: 'NBR 90 Shore A / bronze-filled PTFE',
			mass: '0.12 kg',
			specs: [
				[ 'Seal type', 'U-cup + wiper' ],
				[ 'Temp range', '−30 … +110 °C' ],
				[ 'Rod speed', '≤ 0.8 m/s' ],
				[ 'Service interval', '8 000 h' ],
			],
			description: 'Consumable sealing stack. The U-cup holds pressure, the wiper keeps contaminant off the chrome rod.',
		},
		meshes: [
			m( new LatheGeometry( GLAND_PROFILE, 48 ), MAT.steel(), { x: 0.175, rz: X_AXIS } ),
			m( new TorusGeometry( 0.0620, 0.0098, 14, 44 ), MAT.rubber(), { x: 0.160, ry: Math.PI / 2 } ),
			m( new TorusGeometry( 0.0660, 0.0048, 12, 44 ), MAT.rubber(), { x: 0.185, ry: Math.PI / 2 } ),
			m( new TorusGeometry( 0.0550, 0.0070, 12, 44 ), MAT.rubber(), { x: 0.192, ry: Math.PI / 2 } ),
			m( new CylinderGeometry( 0.0750, 0.0750, 0.009, 48 ), MAT.steel(), { x: 0.204, rz: X_AXIS } ),
		],
	} ) );

	/* --- 6. Chrome rod ------------------------------------------- */
	parts.push( buildPart( {
		id: 'rod',
		name: 'Chrome Piston Rod',
		explodeDir: [ 0.86, 0.34, 0 ],
		explodeDistance: 0.28,
		explodeDelay: 0.06,
		meta: {
			partNo: 'HX2500-140',
			material: 'Hard-chromed 40Cr induction-hardened steel',
			mass: '3.1 kg',
			specs: [
				[ 'Diameter', 'Ø 52 mm h8' ],
				[ 'Chrome depth', '25 µm' ],
				[ 'Surface finish', 'Ra 0.2 µm' ],
				[ 'Column load', '86 kN' ],
			],
			description: 'Transmits piston thrust to the driven load. Chrome face resists scoring and seal wear.',
		},
		meshes: [
			m( new CylinderGeometry( 0.026, 0.026, 0.300, 40 ), MAT.chrome(), { x: 0.340, rz: X_AXIS } ),
			m( new CylinderGeometry( 0.033, 0.033, 0.024, 40 ), MAT.steel(), { x: 0.200, rz: X_AXIS } ),
			m( new CylinderGeometry( 0.021, 0.021, 0.036, 28 ), MAT.steel(), { x: 0.488, rz: X_AXIS } ),
			m( new CylinderGeometry( 0.030, 0.030, 0.016, 6 ), MAT.bolt(), { x: 0.506, rz: X_AXIS } ),
		],
	} ) );

	/* --- 7. Clevis rod end --------------------------------------- */
	parts.push( buildPart( {
		id: 'clevis',
		name: 'Clevis Rod End & Pin',
		explodeDir: [ 1, 0.10, 0 ],
		explodeDistance: 0.32,
		explodeDelay: 0.10,
		meta: {
			partNo: 'HX2500-150',
			material: 'Forged 4140 steel, zinc-flake coated',
			mass: '1.4 kg',
			specs: [
				[ 'Pin Ø', '28 mm h7' ],
				[ 'Swing angle', '± 9°' ],
				[ 'Proof load', '120 kN' ],
			],
			description: 'Articulated load connection. Absorbs minor misalignment between cylinder and driven machine.',
		},
		meshes: [
			m( new BoxGeometry( 0.070, 0.052, 0.062 ), MAT.forged(), { x: 0.512 } ),
			m( new CylinderGeometry( 0.046, 0.046, 0.014, 40 ), MAT.forged(), { x: 0.548, z: 0.030, rx: Math.PI / 2 } ),
			m( new CylinderGeometry( 0.046, 0.046, 0.014, 40 ), MAT.forged(), { x: 0.548, z: - 0.030, rx: Math.PI / 2 } ),
			m( new CylinderGeometry( 0.013, 0.013, 0.086, 24 ), MAT.chrome(), { x: 0.548, rx: Math.PI / 2 } ),
			m( new CylinderGeometry( 0.021, 0.021, 0.009, 24 ), MAT.bolt(), { x: 0.548, z: 0.046, rx: Math.PI / 2 } ),
			m( new TorusGeometry( 0.017, 0.003, 8, 28 ), MAT.bolt(), { x: 0.548, z: - 0.045 } ),
		],
	} ) );

	/* --- 8. Bleed manifold --------------------------------------- */
	parts.push( buildPart( {
		id: 'manifold',
		name: 'Bleed / Port Manifold Valve',
		explodeDir: [ - 0.12, 1, 0.26 ],
		explodeDistance: 0.28,
		explodeDelay: 0.0,
		accent: 0xffb454,
		meta: {
			partNo: 'HX2500-160',
			material: 'CZ121 brass body, PA66 handwheel',
			mass: '0.28 kg',
			specs: [
				[ 'Port', 'G 1/4" BSP' ],
				[ 'Setting range', '0 – 350 bar' ],
				[ 'Max torque', '8 Nm' ],
			],
			description: 'Air-bleed and gauge port. Open during fill to purge trapped air from the bore side.',
		},
		meshes: [
			m( new CylinderGeometry( 0.030, 0.034, 0.030, 28 ), MAT.brass(), { x: - 0.060, y: 0.098 } ),
			m( new CylinderGeometry( 0.027, 0.027, 0.034, 6 ), MAT.brass(), { x: - 0.060, y: 0.128 } ),
			m( new CylinderGeometry( 0.008, 0.008, 0.024, 18 ), MAT.brass(), { x: - 0.060, y: 0.156 } ),
			m( new CylinderGeometry( 0.020, 0.020, 0.015, 28 ), MAT.polymer(), { x: - 0.060, y: 0.172 } ),
			m( new CylinderGeometry( 0.010, 0.010, 0.056, 18 ), MAT.brass(), { x: - 0.004, y: 0.126, rz: X_AXIS } ),
			m( new SphereGeometry( 0.0125, 16, 10 ), MAT.brass(), { x: 0.024, y: 0.126 } ),
		],
	} ) );

	const group = new Group();
	group.name = 'assembly:hx2500';
	for ( const part of parts ) group.add( part.group );

	return {
		id: 'hx2500',
		name: 'HX-2500 Hydraulic Piston Assembly',
		tagline: 'Double-acting cylinder · 2 500 psi · Ø 85 mm bore',
		group,
		parts,
		/** Framing hints consumed by SceneManager / OrbitControls. */
		focus: {
			target: new Vector3( 0.08, 1.02, 0 ),
			camera: new Vector3( 0.62, 1.42, 1.05 ),
			minDistance: 0.35,
			maxDistance: 4.5,
		},
		/** Where the world-space tool menu floats, in assembly-local space. */
		menuAnchor: new Vector3( - 0.34, 0.30, 0.12 ),
	};

}
