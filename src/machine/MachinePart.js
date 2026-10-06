/**
 * MachinePart.js
 * ---------------------------------------------------------------------------
 * Runtime wrapper around one selectable sub-assembly of a machine.
 *
 * A "part" is a THREE.Group of meshes plus the data the UI needs:
 *
 *   meta        human readable specs shown in the spatial tooltip
 *   home        the transform it sits at in the assembled state
 *   explodeDir  unit vector + distance used by the exploded view
 *   proxy       an invisible sphere used for cheap picking / hover tests
 *
 * The class deliberately knows nothing about XR, the DOM or the renderer so it
 * can be unit tested headlessly in Node (see tests/part.test.mjs).
 * ---------------------------------------------------------------------------
 */

import {
	Box3,
	Color,
	EdgesGeometry,
	LineBasicMaterial,
	LineSegments,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	Sphere,
	SphereGeometry,
	Vector3,
} from 'three';

import { clamp } from '../utils/mathUtils.js';

/** Raycaster layer used by invisible picking proxies (see Raycaster.intersectObject: r186 tests layers, not `visible`). */
export const PROXY_LAYER = 1;

const _box = /* @__PURE__ */ new Box3();
const _box2 = /* @__PURE__ */ new Box3();
const _m1 = /* @__PURE__ */ new Matrix4();
const _m2 = /* @__PURE__ */ new Matrix4();
const _tmpVec = /* @__PURE__ */ new Vector3();

/* Shared so 20 proxies do not mean 20 geometries / 20 materials. */
const PROXY_GEOMETRY = /* @__PURE__ */ new SphereGeometry( 1, 16, 10 );
const PROXY_MATERIAL = /* @__PURE__ */ new MeshBasicMaterial( { visible: false, toneMapped: false } );


export class MachinePart {

	/**
	 * @param {Object}   spec
	 * @param {string}   spec.id        Stable id, e.g. 'piston'.
	 * @param {string}   spec.name      Display name, e.g. 'Piston Head Assembly'.
	 * @param {Object}   spec.meta      { partNo, material, mass, specs:[[k,v]], description }
	 * @param {Object3D} spec.group     Group holding the part's meshes.
	 * @param {Vector3}  spec.explodeDir  Unit direction of travel in assembly space.
	 * @param {number}   spec.explodeDistance Metres travelled at t = 1.
	 * @param {number}  [spec.explodeDelay] 0..1 stagger so outer parts move first.
	 * @param {Color}   [spec.accent]    Highlight tint override.
	 */
	constructor( {
		id,
		name,
		meta,
		group,
		explodeDir,
		explodeDistance = 0.25,
		explodeDelay = 0,
		accent = 0x46d3ff,
	} ) {

		this.id = id;
		this.name = name;
		this.meta = meta;
		this.group = group;
		this.group.name = `part:${id}`;
		this.group.userData.partId = id;

		this.accent = new Color( accent );

		/** 0 = idle, 1 = fully highlighted. Damped by the interaction controller. */
		this.highlight = 0;
		/** Target for `highlight`; set by hover / grab / selection state. */
		this.highlightTarget = 0;
		/** True while this part is held by a hand. */
		this.grabbed = false;
		/** True while a pinched hand has this part "latched" for the exploded view. */
		this.latched = false;

		this.explodeDir = explodeDir.clone().normalize();
		this.explodeDistance = explodeDistance;
		this.explodeDelay = clamp( explodeDelay, 0, 0.85 );

		/** Collected once; used for highlight, bounds and disposal. */
		this.meshes = [];
		this.overlays = [];
		this.materials = [];

		group.updateWorldMatrix( true, true );
		this._collect( group );

		// Assembled-state transform, captured after the factory has positioned it.
		this.homePosition = group.position.clone();
		this.homeQuaternion = group.quaternion.clone();
		this.homeScale = group.scale.clone();

		/** Bounding sphere in the part group's local space (computed once). */
		this.localSphere = new Sphere();
		this._computeLocalBounds();

		/** Bounding sphere in assembly space, refreshed once per frame. */
		this.worldSphere = new Sphere( new Vector3(), this.localSphere.radius );

		this.proxy = this._createProxy();

		/** Where the tooltip anchors to, in assembly space. */
		this.anchorOffset = this.localSphere.center.clone();

	}

	/* ------------------------------------------------------------------ *
	 * Build helpers
	 * ------------------------------------------------------------------ */

	_collect( node ) {

		for ( const child of node.children ) {

			if ( child.isMesh ) {

				// Clone the material so `emissive` can be animated per part.
				// Factories are free to share material definitions; isolation
				// is guaranteed here instead.
				child.material = child.material.clone();

				this.meshes.push( child );
				this.materials.push( child.material );

				if ( child.material.emissive === undefined ) continue;

				child.userData.baseEmissive = child.material.emissive.clone();
				child.userData.baseEmissiveIntensity = child.material.emissiveIntensity ?? 1;

				this.overlays.push( this._createOverlay( child ) );

			}

			if ( child.children.length ) this._collect( child );

		}

	}

	/**
	 * Crisp edge overlay used as the "wireframe highlight". EdgesGeometry only
	 * keeps edges whose dihedral angle exceeds the threshold, so cylinders and
	 * lathes read as silhouettes instead of a dense triangle soup.
	 */
	_createOverlay( mesh ) {

		const edges = new EdgesGeometry( mesh.geometry, 32 );
		const material = new LineBasicMaterial( {
			color: this.accent,
			transparent: true,
			opacity: 0,
			depthTest: true,
			depthWrite: false,
			toneMapped: false,
		} );

		const overlay = new LineSegments( edges, material );
		overlay.name = `overlay:${this.id}`;
		overlay.renderOrder = 4;
		overlay.visible = false;
		overlay.raycast = () => {};          // never a pick target
		overlay.matrixAutoUpdate = false;    // static relative to its mesh

		mesh.add( overlay );
		return overlay;

	}

	/** Invisible sphere that both the raycaster and the tooltip use. */
	_createProxy() {

		const proxy = new Mesh( PROXY_GEOMETRY, PROXY_MATERIAL );
		proxy.name = `proxy:${this.id}`;
		proxy.visible = false;
		proxy.layers.set( PROXY_LAYER );
		proxy.position.copy( this.localSphere.center );
		proxy.scale.setScalar( Math.max( this.localSphere.radius, 1e-4 ) );
		proxy.userData.partId = this.id;

		this.group.add( proxy );
		return proxy;

	}

	/**
	 * Bounding sphere of the part expressed in the part group's LOCAL space.
	 *
	 * Deliberately does not use Box3.expandByObject(): that walks world matrices
	 * and would bake in wherever the assembly happens to sit. Instead each mesh's
	 * geometry box is transformed by (group.matrix^-1 * mesh.matrixWorld), which
	 * is correct no matter how deep the group is nested.
	 *
	 * Note: only plain Mesh children are considered. If you add an InstancedMesh
	 * to a part, expand the box manually — a single instance's geometry box would
	 * under-report the bounds.
	 */
	_computeLocalBounds() {

		_box.makeEmpty();
		this.group.updateMatrix();
		_m1.copy( this.group.matrix ).invert();

		for ( const mesh of this.meshes ) {

			mesh.updateWorldMatrix( true, false );
			_m2.multiplyMatrices( _m1, mesh.matrixWorld );

			if ( ! mesh.geometry.boundingBox ) mesh.geometry.computeBoundingBox();
			_box.union( _box2.copy( mesh.geometry.boundingBox ).applyMatrix4( _m2 ) );

		}

		if ( _box.isEmpty() ) {

			this.localSphere.set( new Vector3(), 0.05 );

		} else {

			_box.getBoundingSphere( this.localSphere );

		}

	}

	/* ------------------------------------------------------------------ *
	 * Per-frame
	 * ------------------------------------------------------------------ */

	/**
	 * Transform the cached local bounding sphere into assembly space.
	 * One Matrix4 * Vector3 per part per frame — no geometry traversal.
	 */
	updateWorldSphere() {

		this.worldSphere.center.copy( this.localSphere.center ).applyMatrix4( this.group.matrixWorld );
		this.worldSphere.radius = this.localSphere.radius * this.group.getWorldScale( _tmpVec ).x;
		return this.worldSphere;

	}

	/**
	 * Apply the visual highlight.
	 * @param {number} t 0..1, already damped by the caller.
	 */
	setHighlight( t ) {

		t = clamp( t, 0, 1 );
		if ( t === this.highlight ) return;
		this.highlight = t;

		const emissiveIntensity = 0.05 + t * 0.85;

		for ( let i = 0; i < this.meshes.length; i ++ ) {

			const mesh = this.meshes[ i ];
			const material = mesh.material;

			if ( material.emissive ) {

				material.emissive.copy( mesh.userData.baseEmissive ).lerp( this.accent, t * 0.9 );
				material.emissiveIntensity = ( mesh.userData.baseEmissiveIntensity ?? 1 ) * emissiveIntensity;

			}

			const overlay = this.overlays[ i ];
			if ( overlay ) {

				overlay.visible = t > 0.01;
				overlay.material.opacity = t * 0.9;

			}

		}

	}

	/** Exploded-view position/rotation are written by ExplodeController. */
	resetHome() {

		this.group.position.copy( this.homePosition );
		this.group.quaternion.copy( this.homeQuaternion );
		this.group.scale.copy( this.homeScale );
		this.grabbed = false;
		this.latched = false;

	}

	dispose() {

		for ( const mesh of this.meshes ) mesh.geometry.dispose();
		for ( const material of this.materials ) material.dispose();
		for ( const overlay of this.overlays ) {

			overlay.geometry.dispose();
			overlay.material.dispose();

		}
		this.proxy.geometry.dispose();

	}

}
