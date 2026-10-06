/**
 * GrabController.js
 * ---------------------------------------------------------------------------
 * Pick up, move, rotate (and optionally scale) a machine part with hands.
 *
 * === THE TRANSFORM ALGEBRA =================================================
 *
 * Notation: capital letters are 4x4 homogeneous transforms, `A^-1` is the
 * inverse, `*` is matrix multiplication (apply right-hand operand first).
 *
 * ONE HAND
 * --------
 * Let H  = the hand pivot pose in world space
 *          (position = midpoint of the pinching fingertips,
 *           orientation = wrist joint orientation — see HandState)
 *     P  = the part's world pose at the moment of the grab
 *
 * On grab we store the part's pose *expressed in hand space*:
 *
 *     O = H^-1 * P                                    (grab offset)
 *
 * Then every frame the part is simply re-anchored to the current hand:
 *
 *     P' = H_now * O
 *
 * Because O was captured at grab time, the part does not jump: substituting
 * H_now = H gives P' = H * H^-1 * P = P exactly. Everything after that is
 * rigid-body motion — the part keeps the same offset and attitude relative to
 * the hand, so translating the hand translates the part 1:1 and rotating the
 * wrist rotates the part about the pinch point.
 *
 * The part lives under the assembly group, so the world-space result is
 * converted back into the parent's space before it is written:
 *
 *     P_local = A^-1 * P'          where A = assembly.matrixWorld
 *
 * TWO HANDS
 * ---------
 * Two pinches on the same part switch to a relative-pose solver, because two
 * rigid anchors would over-constrain the part (the hands never hold a fixed
 * distance, so a naive double anchor would tear the part between them).
 *
 * On the second grab we record the two-hand configuration:
 *
 *     M0 = (A0 + B0) / 2                  midpoint
 *     d0 = |B0 - A0|                      span
 *     Q0 = basis( A0, B0 )                orientation built from the hand axis
 *     r0 = P0.position - M0               part offset from the midpoint
 *
 * and each frame:
 *
 *     M  = (A + B) / 2
 *     Q  = basis( A, B )
 *     dQ = Q * Q0^-1                      how the two-hand frame has turned
 *     s  = clamp( |B - A| / d0 )          span ratio (opt-in)
 *
 *     position = M + dQ * ( r0 * s )
 *     rotation = dQ * P0.quaternion
 *
 * So the part keeps its offset from the midpoint, rotated by however much the
 * pair of hands has rotated, and optionally stretched by the change in span.
 * Scaling is OFF by default: silently resizing a hydraulic component in an
 * inspection tool is a lie, so it has to be explicitly enabled.
 *
 * `basis(A,B)` is a Gram-Schmidt frame: X along the hand axis, Y from the
 * average of both hands' up vectors with the X component removed, Z = X × Y.
 *
 * === WHY DAMPED RATHER THAN DIRECT =========================================
 *
 * The write is exponentially damped with a very high lambda (~30/s). At 90 Hz
 * that is ~97 % of the way to target in one frame — visually 1:1, but it
 * removes the single-frame spikes optical tracking produces when a fingertip is
 * briefly occluded. Drop `positionLambda` to ~8 for a deliberately weighty,
 * floating-object feel.
 * ---------------------------------------------------------------------------
 */

import { Matrix4, Quaternion, Vector3 } from 'three';

import { clamp, damp } from '../utils/mathUtils.js';

const _handMatrix = /* @__PURE__ */ new Matrix4();
const _desired = /* @__PURE__ */ new Matrix4();
const _desiredWorld = /* @__PURE__ */ new Matrix4();
const _basisMatrix = /* @__PURE__ */ new Matrix4();
const _parentInverse = /* @__PURE__ */ new Matrix4();
const _local = /* @__PURE__ */ new Matrix4();
const _unitScale = /* @__PURE__ */ new Vector3( 1, 1, 1 );
const _pos = /* @__PURE__ */ new Vector3();
const _scl = /* @__PURE__ */ new Vector3();
const _rot = /* @__PURE__ */ new Quaternion();
const _mid = /* @__PURE__ */ new Vector3();
const _mid0 = /* @__PURE__ */ new Vector3();
const _rel0 = /* @__PURE__ */ new Vector3();
const _axis = /* @__PURE__ */ new Vector3();
const _up = /* @__PURE__ */ new Vector3();
const _right = /* @__PURE__ */ new Vector3();
const _fwd = /* @__PURE__ */ new Vector3();
const _upA = /* @__PURE__ */ new Vector3();
const _upB = /* @__PURE__ */ new Vector3();
const _q0 = /* @__PURE__ */ new Quaternion();
const _qNow = /* @__PURE__ */ new Quaternion();
const _dq = /* @__PURE__ */ new Quaternion();
const _qInv = /* @__PURE__ */ new Quaternion();
const _qPart0 = /* @__PURE__ */ new Quaternion();
const _leash = /* @__PURE__ */ new Vector3();
const UP_LOCAL = /* @__PURE__ */ new Vector3( 0, 1, 0 );

export class GrabController {

	/**
	 * @param {Object} [opts]
	 * @param {number} [opts.positionLambda] Position response, 1/s.
	 * @param {number} [opts.rotationLambda] Rotation response, 1/s.
	 * @param {number} [opts.leashDistance]  Metres from the assembled home
	 *        position beyond which the part resists further travel. Prevents
	 *        components being thrown out of the workspace and lost.
	 * @param {boolean}[opts.twoHandScale]   Allow the hand span to scale a part.
	 * @param {[number,number]}[opts.scaleRange]
	 */
	constructor( {
		positionLambda = 30,
		rotationLambda = 26,
		leashDistance = 1.1,
		twoHandScale = false,
		scaleRange = [ 0.6, 1.6 ],
	} = {} ) {

		this.positionLambda = positionLambda;
		this.rotationLambda = rotationLambda;
		this.leashDistance = leashDistance;
		this.twoHandScale = twoHandScale;
		this.scaleRange = scaleRange;

		/** @type {?import('../machine/MachinePart.js').MachinePart} */
		this.part = null;
		/** 'none' | 'one' | 'two' */
		this.mode = 'none';

		this._parent = null;
		this._offset = new Matrix4();

		// Two-hand bookkeeping
		this._span0 = 0;
		this._pos0 = new Vector3();
		this._scaleNow = 1;

		/** Fired by the app for haptics / sound. */
		this.onGrab = null;
		this.onRelease = null;

	}

	get isGrabbing() {

		return this.part !== null;

	}

	/**
	 * @param {import('../machine/MachinePart.js').MachinePart} part
	 * @param {{position: Vector3, quaternion: Quaternion}} pivot Hand pivot, world space.
	 * @param {import('three').Object3D} parent The assembly group the part lives under.
	 */
	attach( part, pivot, parent ) {

		this.part = part;
		this._parent = parent;
		this.mode = 'one';

		part.grabbed = true;

		// O = H^-1 * P
		_handMatrix.compose( pivot.position, pivot.quaternion, _unitScale );
		this._offset.copy( _handMatrix ).invert().multiply( part.group.matrixWorld );

		this._pos0.copy( part.group.position );
		this._scaleNow = 1;

		this.onGrab?.( part );
		return part;

	}

	/** Promote the current grab to two hands. `pivotB` is the second hand. */
	addSecondHand( pivotA, pivotB ) {

		if ( ! this.part || this.mode === 'two' ) return false;

		this.mode = 'two';

		_mid0.addVectors( pivotA.position, pivotB.position ).multiplyScalar( 0.5 );
		this._span0 = Math.max( pivotA.position.distanceTo( pivotB.position ), 1e-4 );

		this._twoHandBasis( pivotA, pivotB, _q0 );
		_rel0.copy( this._partWorldPosition() ).sub( _mid0 );
		_qPart0.copy( this._partWorldQuaternion() );

		return true;

	}

	/**
	 * Advance the grabbed part. Call once per frame while `isGrabbing`.
	 *
	 * @param {{position: Vector3, quaternion: Quaternion}} pivotA
	 * @param {?{position: Vector3, quaternion: Quaternion}} pivotB
	 * @param {number} dt
	 * @returns {boolean} True if the part moved.
	 */
	update( pivotA, pivotB, dt ) {

		const part = this.part;
		if ( ! part || ! this._parent ) return false;

		// 1. Solve for the desired WORLD pose of the part -> (_pos, _rot).
		if ( this.mode === 'two' && pivotB ) {

			this._solveTwoHands( pivotA, pivotB );

		} else {

			// P' = H_now * O
			_handMatrix.compose( pivotA.position, pivotA.quaternion, _unitScale );
			_desired.multiplyMatrices( _handMatrix, this._offset );
			_desired.decompose( _pos, _rot, _scl );

		}

		// 2. Leash, in world space, BEFORE the frame conversion — otherwise the
		//    clamp would be thrown away by the re-multiply in step 3.
		this._applyLeash( part, _pos );

		// 3. World -> assembly-local, because the part is a child of the assembly.
		_desiredWorld.compose( _pos, _rot, _unitScale );
		_parentInverse.copy( this._parent.matrixWorld ).invert();
		_local.multiplyMatrices( _parentInverse, _desiredWorld );
		_local.decompose( _pos, _rot, _scl );

		// 4. Damped write (see header).
		const before = part.group.position.distanceToSquared( _pos );

		part.group.position.lerp( _pos, 1 - Math.exp( - this.positionLambda * dt ) );
		part.group.quaternion.slerp( _rot, 1 - Math.exp( - this.rotationLambda * dt ) );

		return before > 1e-10;

	}

	/**
	 * Drop back to one hand without a jump: the grab offset is re-solved against
	 * the hand that is staying, so the part does not teleport when the second
	 * hand opens.
	 *
	 * @param {{position: Vector3, quaternion: Quaternion}} pivotRemaining
	 */
	dropSecondHand( pivotRemaining ) {

		if ( this.mode !== 'two' || ! this.part ) return false;

		this.mode = 'one';
		_handMatrix.compose( pivotRemaining.position, pivotRemaining.quaternion, _unitScale );
		this._offset.copy( _handMatrix ).invert().multiply( this.part.group.matrixWorld );
		return true;

	}

	/**
	 * Let go. The part stays where it was dropped; `reset()` returns it home.
	 * @returns {?import('../machine/MachinePart.js').MachinePart}
	 */
	release() {

		const part = this.part;
		if ( ! part ) return null;

		part.grabbed = false;
		this.part = null;
		this.mode = 'none';
		this._parent = null;
		this._scaleNow = 1;

		this.onRelease?.( part );
		return part;

	}

	/* ------------------------------------------------------------------ *
	 * Internals
	 * ------------------------------------------------------------------ */

	_solveTwoHands( pivotA, pivotB ) {

		_mid.addVectors( pivotA.position, pivotB.position ).multiplyScalar( 0.5 );
		const span = Math.max( pivotA.position.distanceTo( pivotB.position ), 1e-4 );

		this._twoHandBasis( pivotA, pivotB, _qNow );
		_qInv.copy( _q0 ).invert();
		_dq.multiplyQuaternions( _qNow, _qInv );

		const scale = this.twoHandScale
			? clamp( span / this._span0, this.scaleRange[ 0 ], this.scaleRange[ 1 ] )
			: 1;
		this._scaleNow = scale;

		_pos.copy( _rel0 ).multiplyScalar( scale ).applyQuaternion( _dq ).add( _mid );
		_rot.multiplyQuaternions( _dq, _qPart0 );

	}

	/** Gram-Schmidt frame spanning the two hands (see header). */
	_twoHandBasis( pivotA, pivotB, out ) {

		_axis.subVectors( pivotB.position, pivotA.position );
		if ( _axis.lengthSq() < 1e-10 ) return out.copy( pivotA.quaternion );
		_right.copy( _axis ).normalize();

		_upA.copy( UP_LOCAL ).applyQuaternion( pivotA.quaternion );
		_upB.copy( UP_LOCAL ).applyQuaternion( pivotB.quaternion );
		_up.addVectors( _upA, _upB );

		// Reject the component along the hand axis, then renormalise.
		_up.addScaledVector( _right, - _up.dot( _right ) );
		if ( _up.lengthSq() < 1e-10 ) _up.set( 0, 1, 0 ).addScaledVector( _right, - _right.y ).normalize();
		_up.normalize();

		_fwd.crossVectors( _right, _up );

		return out.setFromRotationMatrix( _basisMatrix.makeBasis( _right, _up, _fwd ) );

	}

	/** Soft leash: clamp travel to a sphere around the assembled home position. */
	_applyLeash( part, worldPos ) {

		_leash.copy( part.homePosition ).applyMatrix4( this._parent.matrixWorld );
		const offset = worldPos.distanceTo( _leash );

		if ( offset > this.leashDistance ) {

			worldPos.sub( _leash ).multiplyScalar( this.leashDistance / offset ).add( _leash );

		}

	}

	_partWorldPosition() {

		return this.part.group.getWorldPosition( new Vector3() );

	}

	_partWorldQuaternion() {

		return this.part.group.getWorldQuaternion( new Quaternion() );

	}

}
