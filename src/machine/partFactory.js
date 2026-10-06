/**
 * partFactory.js
 * ---------------------------------------------------------------------------
 * Shared assembly-authoring helper.
 *
 * The important step is re-centring: a MachinePart rotates about its group
 * origin, and users expect a grabbed component to spin about its own centre of
 * mass — not about the machine's origin, which would swing it through the rest
 * of the assembly. So meshes are authored in assembly space, the centroid is
 * computed, and every mesh is offset by -centroid while the group is placed at
 * +centroid. World positions are unchanged; the rotation pivot is not.
 * ---------------------------------------------------------------------------
 */

import { Box3, Group, Vector3 } from 'three';

import { MachinePart } from './MachinePart.js';

/**
 * @param {Object} spec
 * @param {string} spec.id
 * @param {string} spec.name
 * @param {Object} spec.meta
 * @param {import('three').Mesh[]} spec.meshes  Positioned in ASSEMBLY space.
 * @param {number[]} spec.explodeDir
 * @param {number} [spec.explodeDistance]
 * @param {number} [spec.explodeDelay]
 * @param {number} [spec.accent]
 * @returns {MachinePart}
 */
export function buildPart( {
	id,
	name,
	meta,
	meshes,
	explodeDir,
	explodeDistance = 0.26,
	explodeDelay = 0,
	accent,
} ) {

	const group = new Group();
	const box = new Box3();
	const tmp = new Box3();

	for ( const mesh of meshes ) {

		mesh.updateMatrix();
		if ( ! mesh.geometry.boundingBox ) mesh.geometry.computeBoundingBox();
		box.union( tmp.copy( mesh.geometry.boundingBox ).applyMatrix4( mesh.matrix ) );

	}

	const center = box.isEmpty() ? new Vector3() : box.getCenter( new Vector3() );

	for ( const mesh of meshes ) {

		mesh.position.sub( center );
		group.add( mesh );

	}
	group.position.copy( center );

	return new MachinePart( {
		id,
		name,
		meta,
		group,
		explodeDir: new Vector3( ...explodeDir ),
		explodeDistance,
		explodeDelay,
		...( accent !== undefined ? { accent } : {} ),
	} );

}
