/**
 * HandRenderer.js
 * ---------------------------------------------------------------------------
 * Draws the user's hands from joint poses.
 *
 * A naive implementation adds a mesh per joint (25 per hand) and a mesh per
 * bone (24 per hand) — 98 draw calls before the machine is even rendered. This
 * uses two InstancedMeshes for both hands combined:
 *
 *   1 draw call  ->  up to 50 joint spheres
 *   1 draw call  ->  up to 48 bone capsules
 *   2 draw calls ->  pinch rings
 *
 * Instances are compacted every frame (invisible joints are skipped and
 * `.count` is lowered) rather than scaled to zero, so no degenerate triangles
 * reach the rasteriser.
 *
 * Instance matrices are written with `setMatrixAt`, which fills a single
 * InstancedBufferAttribute flagged DynamicDrawUsage — one buffer upload per
 * frame per mesh, not one per joint.
 * ---------------------------------------------------------------------------
 */

import {
	CapsuleGeometry,
	Color,
	DoubleSide,
	Group,
	InstancedMesh,
	Matrix4,
	Mesh,
	MeshStandardMaterial,
	Quaternion,
	RingGeometry,
	SphereGeometry,
	Vector3,
	DynamicDrawUsage,
} from 'three';

import { BONE_LINKS, JOINT_NAMES } from '../interaction/HandState.js';
import { clamp, damp } from '../utils/mathUtils.js';

const _matrix = /* @__PURE__ */ new Matrix4();
const _pos = /* @__PURE__ */ new Vector3();
const _dir = /* @__PURE__ */ new Vector3();
const _scale = /* @__PURE__ */ new Vector3();
const _quat = /* @__PURE__ */ new Quaternion();
const UP = /* @__PURE__ */ new Vector3( 0, 1, 0 );

const HAND_COLORS = {
	left: new Color( 0x58c8ff ),
	right: new Color( 0x9be7ff ),
};

export class HandRenderer {

	/**
	 * @param {Object} [opts]
	 * @param {number} [opts.jointScale] Multiplier on the runtime's joint radius.
	 * @param {number} [opts.boneScale]  Bone thickness relative to joint radius.
	 * @param {boolean}[opts.castShadow]
	 */
	constructor( { jointScale = 1.0, boneScale = 0.62, castShadow = true } = {} ) {

		this.jointScale = jointScale;
		this.boneScale = boneScale;

		this.group = new Group();
		this.group.name = 'hands';
		this.group.renderOrder = 2;

		const maxJoints = JOINT_NAMES.length * 2;
		const maxBones = BONE_LINKS.length * 2;

		this.jointGeometry = new SphereGeometry( 1, 12, 8 );
		this.jointMaterial = new MeshStandardMaterial( {
			color: 0xffffff,
			roughness: 0.42,
			metalness: 0.15,
			emissive: 0x0d3b52,
			emissiveIntensity: 0.85,
		} );

		this.joints = new InstancedMesh( this.jointGeometry, this.jointMaterial, maxJoints );
		this.joints.instanceMatrix.setUsage( DynamicDrawUsage );
		this.joints.frustumCulled = false;   // instances move; the bounding sphere would lie
		this.joints.castShadow = castShadow;
		this.joints.count = 0;
		this.joints.name = 'hand-joints';

		this.boneGeometry = new CapsuleGeometry( 1, 1, 4, 8 );
		this.boneMaterial = new MeshStandardMaterial( {
			color: 0x1c2a33,
			roughness: 0.55,
			metalness: 0.25,
			emissive: 0x08222e,
			emissiveIntensity: 0.7,
		} );

		this.bones = new InstancedMesh( this.boneGeometry, this.boneMaterial, maxBones );
		this.bones.instanceMatrix.setUsage( DynamicDrawUsage );
		this.bones.frustumCulled = false;
		this.bones.castShadow = castShadow;
		this.bones.count = 0;
		this.bones.name = 'hand-bones';

		this.group.add( this.joints, this.bones );

		/* Pinch rings: a readable "you are pinching" cue, since most hand-tracking
		   runtimes have no haptics to fall back on. */
		this.rings = [];
		for ( let i = 0; i < 2; i ++ ) {

			const ring = new Mesh(
				new RingGeometry( 0.011, 0.016, 28 ),
				new MeshStandardMaterial( {
					color: 0x7ff0ff,
					emissive: 0x2ad4ff,
					emissiveIntensity: 2.2,
					transparent: true,
					opacity: 0,
					side: DoubleSide,
					depthWrite: false,
					toneMapped: false,
				} )
			);
			ring.name = `pinch-ring-${i}`;
			ring.visible = false;
			ring.renderOrder = 6;
			this.rings.push( ring );
			this.group.add( ring );

		}

		this._ringOpacity = [ 0, 0 ];
		this._color = new Color();

	}

	/**
	 * @param {import('../interaction/HandState.js').HandState[]} hands
	 * @param {number} dt
	 * @param {import('three').Camera} camera Used to billboard the pinch rings.
	 */
	update( hands, dt, camera ) {

		let jointIndex = 0;
		let boneIndex = 0;

		for ( let h = 0; h < hands.length; h ++ ) {

			const hand = hands[ h ];
			const tint = HAND_COLORS[ hand.handedness ] ?? HAND_COLORS.right;

			if ( ! hand.visible ) {

				this._ringOpacity[ h ] = damp( this._ringOpacity[ h ], 0, 14, dt );
				this._updateRing( h, hand, camera, dt );
				continue;

			}

			/* joints */
			for ( const name of JOINT_NAMES ) {

				const joint = hand.joints.get( name );
				if ( ! joint.valid ) continue;

				const r = Math.max( joint.radius, 0.004 ) * this.jointScale *
					( name.endsWith( '-tip' ) ? 1.15 : 1 );

				_scale.setScalar( r );
				_matrix.compose( joint.position, joint.quaternion, _scale );
				this.joints.setMatrixAt( jointIndex, _matrix );
				this.joints.setColorAt( jointIndex, tint );
				jointIndex ++;

			}

			/* bones */
			for ( const [ fromName, toName ] of BONE_LINKS ) {

				const a = hand.joints.get( fromName );
				const b = hand.joints.get( toName );
				if ( ! a.valid || ! b.valid ) continue;

				_dir.subVectors( b.position, a.position );
				const length = _dir.length();
				if ( length < 1e-5 ) continue;
				_dir.divideScalar( length );

				// CapsuleGeometry is authored along +Y with its origin at the
				// centre of the cylindrical section, so: aim +Y at the bone
				// direction, place at the midpoint, stretch Y by the length.
				_quat.setFromUnitVectors( UP, _dir );
				_pos.addVectors( a.position, b.position ).multiplyScalar( 0.5 );

				const radius = Math.max( ( a.radius + b.radius ) * 0.5, 0.004 ) * this.boneScale;
				_scale.set( radius, Math.max( length - radius * 2, 0.001 ), radius );

				_matrix.compose( _pos, _quat, _scale );
				this.bones.setMatrixAt( boneIndex, _matrix );
				this.bones.setColorAt( boneIndex, tint );
				boneIndex ++;

			}

			this._ringOpacity[ h ] = damp( this._ringOpacity[ h ], 0.25 + hand.pinchStrength * 0.75, 16, dt );
			this._updateRing( h, hand, camera, dt );

		}

		this.joints.count = jointIndex;
		this.bones.count = boneIndex;

		if ( jointIndex > 0 ) {

			this.joints.instanceMatrix.needsUpdate = true;
			if ( this.joints.instanceColor ) this.joints.instanceColor.needsUpdate = true;

		}
		if ( boneIndex > 0 ) {

			this.bones.instanceMatrix.needsUpdate = true;
			if ( this.bones.instanceColor ) this.bones.instanceColor.needsUpdate = true;

		}

	}

	_updateRing( i, hand, camera, dt ) {

		const ring = this.rings[ i ];
		const opacity = this._ringOpacity[ i ];

		ring.visible = opacity > 0.02;
		if ( ! ring.visible ) return;

		ring.position.copy( hand.pivotPosition );
		if ( camera ) ring.quaternion.copy( camera.quaternion );

		// Grow slightly as the pinch closes, so the ring reads as a dial.
		const s = 0.7 + hand.pinchStrength * 0.9;
		ring.scale.setScalar( clamp( s, 0.2, 2.5 ) );
		ring.material.opacity = opacity;

	}

	setVisible( visible ) {

		this.group.visible = visible;

	}

	dispose() {

		this.jointGeometry.dispose();
		this.jointMaterial.dispose();
		this.boneGeometry.dispose();
		this.boneMaterial.dispose();
		for ( const ring of this.rings ) {

			ring.geometry.dispose();
			ring.material.dispose();

		}

	}

}
