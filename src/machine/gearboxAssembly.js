/**
 * gearboxAssembly.js
 * ---------------------------------------------------------------------------
 * "PG-140" single-stage planetary gearbox.
 *
 * Exists for two reasons: it is a genuinely different machine to inspect, and
 * it proves the assembly contract. Nothing in the interaction, tooltip or menu
 * layers knows which machine is loaded — they consume `parts: MachinePart[]`,
 * so a second entry in the registry is all it takes.
 * ---------------------------------------------------------------------------
 */

import {
	BoxGeometry,
	CylinderGeometry,
	DoubleSide,
	Group,
	Mesh,
	MeshStandardMaterial,
	TorusGeometry,
	Vector3,
} from 'three';

import { MachinePart } from './MachinePart.js';
import { boltRing, gearGeometry } from './geometryKit.js';
import { buildPart } from './partFactory.js';

const metal = ( color, metalness = 0.9, roughness = 0.35, extra ) =>
	new MeshStandardMaterial( { color, metalness, roughness, envMapIntensity: 1.2, ...extra } );

const MAT = {
	aluminium: () => metal( 0x545b63, 0.85, 0.44, { side: DoubleSide } ),
	caseIron:  () => metal( 0x3f454c, 0.78, 0.52 ),
	gearSteel: () => metal( 0xa7aeb6, 0.96, 0.24 ),
	hardened:  () => metal( 0xcfd6dd, 1.0, 0.10 ),
	bolt:      () => metal( 0x2f343a, 0.90, 0.48 ),
	copper:    () => metal( 0xb07a45, 1.0, 0.32 ),
};

const X_AXIS = - Math.PI / 2;
const GEAR_AXIS = Math.PI / 2;   // extruded gears run along +Z; rotate onto +X

function m( geometry, material, opts = {} ) {

	const mesh = new Mesh( geometry, material );
	mesh.position.set( opts.x ?? 0, opts.y ?? 0, opts.z ?? 0 );
	mesh.rotation.set( opts.rx ?? 0, opts.ry ?? 0, opts.rz ?? 0 );
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	return mesh;

}

export function createGearboxAssembly() {

	const parts = [];

	/* --- 1. Front cover ------------------------------------------ */
	parts.push( buildPart( {
		id: 'front-cover',
		name: 'Front Cover & Bearing Seat',
		explodeDir: [ - 1, 0.08, 0 ],
		explodeDistance: 0.26,
		explodeDelay: 0.02,
		meta: {
			partNo: 'PG140-101',
			material: 'AlSi10Mg die-cast aluminium',
			mass: '1.6 kg',
			specs: [
				[ 'Bearing', '6205-2RS deep groove' ],
				[ 'Bolt circle', '8 × M8 × 1.25' ],
				[ 'Seal', 'NBR radial lip' ],
			],
			description: 'Input-side cover. Locates the sun shaft bearing and carries the input seal.',
		},
		meshes: [
			m( new CylinderGeometry( 0.125, 0.125, 0.022, 56 ), MAT.aluminium(), { x: - 0.076, rz: X_AXIS } ),
			m( new CylinderGeometry( 0.040, 0.040, 0.030, 32 ), MAT.aluminium(), { x: - 0.086, rz: X_AXIS } ),
			m( new TorusGeometry( 0.032, 0.005, 10, 32 ), MAT.bolt(), { x: - 0.064, ry: GEAR_AXIS } ),
			m( boltRing( { count: 8, radius: 0.104, headRadius: 0.008, headHeight: 0.008, shankRadius: 0.0045, shankHeight: 0.024, axis: 'x' } ), MAT.bolt(), { x: - 0.076 } ),
		],
	} ) );

	/* --- 2. Main case -------------------------------------------- */
	parts.push( buildPart( {
		id: 'case',
		name: 'Gear Case',
		explodeDir: [ 0, 1, 0 ],
		explodeDistance: 0.24,
		explodeDelay: 0.08,
		meta: {
			partNo: 'PG140-102',
			material: 'GG25 grey cast iron',
			mass: '4.4 kg',
			specs: [
				[ 'Oil charge', '0.35 L ISO VG 220' ],
				[ 'Rating', 'IP65 when sealed' ],
				[ 'Mounting', '4 × Ø 11 mm' ],
			],
			description: 'Main housing. Carries the ring gear and the output bearing pair.',
		},
		meshes: [
			m( new CylinderGeometry( 0.125, 0.125, 0.130, 56, 1, true ), MAT.caseIron(), { rz: X_AXIS } ),
			m( new CylinderGeometry( 0.140, 0.140, 0.016, 56 ), MAT.caseIron(), { x: 0.066, rz: X_AXIS } ),
			m( new BoxGeometry( 0.030, 0.026, 0.050 ), MAT.caseIron(), { y: 0.132 } ),
			m( new CylinderGeometry( 0.010, 0.010, 0.026, 16 ), MAT.copper(), { y: 0.148 } ),
		],
	} ) );

	/* --- 3. Ring gear -------------------------------------------- */
	parts.push( buildPart( {
		id: 'ring-gear',
		name: 'Internal Ring Gear',
		explodeDir: [ 0, - 1, 0 ],
		explodeDistance: 0.20,
		explodeDelay: 0.18,
		accent: 0xffb454,
		meta: {
			partNo: 'PG140-110',
			material: '20MnCr5 case-hardened steel',
			mass: '2.1 kg',
			specs: [
				[ 'Teeth', '72 (internal)' ],
				[ 'Module', '1.5 mm' ],
				[ 'Face width', '22 mm' ],
				[ 'Hardness', '58–62 HRC' ],
			],
			description: 'Fixed internal gear. The planets roll inside it, which is what produces the reduction.',
		},
		meshes: [
			m( gearGeometry( { teeth: 48, outerRadius: 0.115, rootRadius: 0.104, thickness: 0.050, boreRadius: 0 } ), MAT.gearSteel(), { ry: GEAR_AXIS } ),
			m( new CylinderGeometry( 0.121, 0.121, 0.050, 56, 1, true ), MAT.gearSteel(), { rz: X_AXIS } ),
		],
	} ) );

	/* --- 4. Planet carrier --------------------------------------- */
	parts.push( buildPart( {
		id: 'carrier',
		name: 'Planet Carrier & Planets',
		explodeDir: [ 0.30, 0.60, 0.25 ],
		explodeDistance: 0.28,
		explodeDelay: 0.12,
		meta: {
			partNo: 'PG140-120',
			material: '42CrMo4 carrier, 16MnCr5 planets',
			mass: '1.8 kg',
			specs: [
				[ 'Planets', '3 × 24 T' ],
				[ 'Ratio', '4.00 : 1' ],
				[ 'Output torque', '140 Nm' ],
				[ 'Bearings', 'Needle roller' ],
			],
			description: 'Output member of the gear set. The three planets orbit the sun while driving the carrier round.',
		},
		meshes: [
			m( new CylinderGeometry( 0.062, 0.062, 0.014, 40 ), MAT.gearSteel(), { x: 0.030, rz: X_AXIS } ),
			m( new CylinderGeometry( 0.050, 0.050, 0.014, 40 ), MAT.gearSteel(), { x: - 0.032, rz: X_AXIS } ),
			m( gearGeometry( { teeth: 24, outerRadius: 0.042, rootRadius: 0.036, thickness: 0.044, boreRadius: 0.010 } ), MAT.hardened(), { x: 0.055, y: 0.0, z: 0.058, ry: GEAR_AXIS } ),
			m( gearGeometry( { teeth: 24, outerRadius: 0.042, rootRadius: 0.036, thickness: 0.044, boreRadius: 0.010 } ), MAT.hardened(), { x: 0.055, y: 0.050, z: - 0.029, ry: GEAR_AXIS } ),
			m( gearGeometry( { teeth: 24, outerRadius: 0.042, rootRadius: 0.036, thickness: 0.044, boreRadius: 0.010 } ), MAT.hardened(), { x: 0.055, y: - 0.050, z: - 0.029, ry: GEAR_AXIS } ),
			m( new CylinderGeometry( 0.009, 0.009, 0.086, 20 ), MAT.hardened(), { y: 0.0, z: 0.058, rz: X_AXIS } ),
			m( new CylinderGeometry( 0.009, 0.009, 0.086, 20 ), MAT.hardened(), { y: 0.050, z: - 0.029, rz: X_AXIS } ),
			m( new CylinderGeometry( 0.009, 0.009, 0.086, 20 ), MAT.hardened(), { y: - 0.050, z: - 0.029, rz: X_AXIS } ),
		],
	} ) );

	/* --- 5. Sun gear --------------------------------------------- */
	parts.push( buildPart( {
		id: 'sun-gear',
		name: 'Sun Gear & Input Hub',
		explodeDir: [ - 0.45, 0.60, 0 ],
		explodeDistance: 0.26,
		explodeDelay: 0.22,
		meta: {
			partNo: 'PG140-130',
			material: '18CrNiMo7-6 carburised steel',
			mass: '0.7 kg',
			specs: [
				[ 'Teeth', '18' ],
				[ 'Module', '1.5 mm' ],
				[ 'Input speed', '3 000 rpm max' ],
			],
			description: 'Input member. Driven by the motor shaft, it is the smallest gear and therefore the fastest.',
		},
		meshes: [
			m( gearGeometry( { teeth: 18, outerRadius: 0.030, rootRadius: 0.025, thickness: 0.046, boreRadius: 0.008 } ), MAT.hardened(), { x: 0.0, ry: GEAR_AXIS } ),
			m( new CylinderGeometry( 0.014, 0.014, 0.070, 24 ), MAT.hardened(), { x: - 0.030, rz: X_AXIS } ),
		],
	} ) );

	/* --- 6. Output shaft ----------------------------------------- */
	parts.push( buildPart( {
		id: 'output-shaft',
		name: 'Output Shaft & Key',
		explodeDir: [ 1, 0.10, 0 ],
		explodeDistance: 0.30,
		explodeDelay: 0.06,
		meta: {
			partNo: 'PG140-140',
			material: '42CrMo4 QT, ground journal',
			mass: '1.1 kg',
			specs: [
				[ 'Shaft Ø', '25 mm k6' ],
				[ 'Key', '8 × 7 DIN 6885' ],
				[ 'Radial load', '2.4 kN at 30 mm' ],
			],
			description: 'Delivers reduced speed and multiplied torque to the driven machine.',
		},
		meshes: [
			m( new CylinderGeometry( 0.026, 0.026, 0.110, 32 ), MAT.hardened(), { x: 0.100, rz: X_AXIS } ),
			m( new CylinderGeometry( 0.034, 0.034, 0.022, 32 ), MAT.gearSteel(), { x: 0.052, rz: X_AXIS } ),
			m( gearGeometry( { teeth: 12, outerRadius: 0.052, rootRadius: 0.046, thickness: 0.016, boreRadius: 0.026 } ), MAT.gearSteel(), { x: 0.038, ry: GEAR_AXIS } ),
			m( new CylinderGeometry( 0.004, 0.004, 0.036, 12 ), MAT.bolt(), { x: 0.120, y: 0.026 } ),
		],
	} ) );

	const group = new Group();
	group.name = 'assembly:pg140';
	for ( const part of parts ) group.add( part.group );

	return {
		id: 'pg140',
		name: 'PG-140 Planetary Gearbox',
		tagline: 'Single-stage planetary · 4:1 · 140 Nm output',
		group,
		parts,
		menuAnchor: new Vector3( - 0.30, 0.26, 0.12 ),
	};

}
