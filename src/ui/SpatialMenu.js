/**
 * SpatialMenu.js
 * ---------------------------------------------------------------------------
 * In-world tool buttons for immersive sessions.
 *
 * A DOM HUD is invisible inside immersive-vr, so anything the user must be able
 * to do in a headset needs a world-space equivalent. These buttons live beside
 * the machine, billboard towards the viewer, and are hit-tested two ways:
 *
 *   1. a short ray from the wrist through the index tip (the natural "point at
 *      it" gesture, and the same ray a controller would use), and
 *   2. direct fingertip proximity, for the "poke the button" style that hand
 *      tracking users actually reach for.
 *
 * Activation happens on pinch, dispatched by HandInteractionController, so a
 * button press and a part grab are the same gesture with a different target —
 * one mental model for the whole app.
 * ---------------------------------------------------------------------------
 */

import {
	CanvasTexture,
	DoubleSide,
	Group,
	Mesh,
	MeshBasicMaterial,
	PlaneGeometry,
	Raycaster,
	SRGBColorSpace,
	Vector3,
} from 'three';

import { damp } from '../utils/mathUtils.js';

const BTN_W = 0.115;
const BTN_H = 0.048;
const BTN_GAP = 0.012;
const CANVAS_W = 512;
const CANVAS_H = 214;

const _ray = /* @__PURE__ */ new Raycaster();
const _origin = /* @__PURE__ */ new Vector3();
const _dir = /* @__PURE__ */ new Vector3();
const _camPos = /* @__PURE__ */ new Vector3();

export class SpatialMenu {

	/**
	 * @param {Object} opts
	 * @param {Object} opts.parent            Object3D the menu is anchored to.
	 * @param {Vector3} opts.anchor           Offset from the parent's origin.
	 * @param {{id:string,label:string,onSelect?:Function,state?:Function}[]} opts.buttons
	 */
	constructor( { parent, anchor, buttons } ) {

		this.group = new Group();
		this.group.name = 'spatial-menu';
		parent.add( this.group );
		this.group.position.copy( anchor );

		this.buttons = [];
		this.hoveredId = null;

		const total = buttons.length * ( BTN_H + BTN_GAP ) - BTN_GAP;
		let y = total / 2 - BTN_H / 2;

		for ( const spec of buttons ) {

			const canvas = this._createCanvas();
			const texture = new CanvasTexture( canvas );
			texture.colorSpace = SRGBColorSpace;
			texture.anisotropy = 4;

			const mesh = new Mesh(
				new PlaneGeometry( BTN_W, BTN_H ),
				new MeshBasicMaterial( {
					map: texture,
					transparent: true,
					depthTest: false,
					depthWrite: false,
					toneMapped: false,
					side: DoubleSide,
				} )
			);
			mesh.position.set( 0, y, 0 );
			mesh.renderOrder = 15;
			mesh.name = `menu:${spec.id}`;
			this.group.add( mesh );

			const button = {
				...spec,
				mesh,
				canvas,
				ctx: canvas.getContext( '2d' ),
				texture,
				hover: 0,
				flash: 0,
				signature: '',
			};

			this.buttons.push( button );
			this._paintButton( button );
			y -= BTN_H + BTN_GAP;

		}

	}

	_createCanvas() {

		const canvas = typeof document !== 'undefined'
			? document.createElement( 'canvas' )
			: { width: CANVAS_W, height: CANVAS_H, getContext: () => null };
		canvas.width = CANVAS_W;
		canvas.height = CANVAS_H;
		return canvas;

	}

	/**
	 * Hit test + hover animation.
	 * @param {import('../interaction/HandState.js').HandState[]} hands
	 * @param {number} dt
	 * @param {import('three').Camera} [camera]
	 */
	update( hands, dt, camera ) {

		if ( camera ) {

			camera.getWorldPosition( _camPos );
			this.group.lookAt( _camPos );

		}

		let hovered = null;

		for ( const hand of hands ) {

			if ( ! hand.visible ) continue;

			const id = this.pick( hand );
			if ( id ) {

				hovered = id;
				break;

			}

		}

		this.hoveredId = hovered;

		for ( const button of this.buttons ) {

			const want = button.id === hovered ? 1 : 0;
			button.hover = damp( button.hover, want, 16, dt );
			button.flash = damp( button.flash, 0, 6, dt );

			const s = 1 + button.hover * 0.06 + button.flash * 0.12;
			button.mesh.scale.setScalar( s );
			button.mesh.position.z = button.hover * 0.006 + button.flash * 0.01;

			// Repaint only when the label/state text actually changes, plus the
			// hover transition (cheap: 512x214 canvas, only on change).
			const signature = `${button.label}|${button.state?.() ?? ''}|${button.hover > 0.5 ? 1 : 0}`;
			if ( signature !== button.signature ) {

				button.signature = signature;
				this._paintButton( button );
				button.texture.needsUpdate = true;

			}

		}

	}

	/**
	 * Which button (if any) is under this hand?
	 * @param {import('../interaction/HandState.js').HandState} hand
	 * @returns {?string}
	 */
	pick( hand ) {

		// 1. Point ray: wrist -> index tip, extended a little past the fingertip.
		_origin.copy( hand.wrist );
		_dir.subVectors( hand.indexTip, hand.wrist );
		const len = _dir.length();
		if ( len < 1e-5 ) return null;
		_dir.divideScalar( len );

		_ray.set( _origin, _dir );
		_ray.far = len + 0.05;
		_ray.near = 0;

		const hits = _ray.intersectObjects( this.buttons.map( ( b ) => b.mesh ), false );
		if ( hits.length > 0 ) {

			return hits[ 0 ].object.name.slice( 'menu:'.length );

		}

		// 2. Poke: fingertip within 18 mm of a button's centre.
		let best = null;
		let bestD = 0.018;

		for ( const button of this.buttons ) {

			const d = hand.indexTip.distanceTo( button.mesh.getWorldPosition( _dir ) );
			if ( d < bestD ) {

				bestD = d;
				best = button.id;

			}

		}

		return best;

	}

	activate( id ) {

		const button = this.buttons.find( ( b ) => b.id === id );
		if ( ! button ) return false;

		button.flash = 1;
		button.signature = '';      // force a repaint next frame
		button.onSelect?.( button );
		return true;

	}

	/** Force every button to repaint (e.g. after a state change elsewhere). */
	invalidate() {

		for ( const button of this.buttons ) button.signature = '';

	}

	_paintButton( button ) {

		const ctx = button.ctx;
		if ( ! ctx ) return;

		const hovered = button.hover > 0.5;
		const stateText = button.state?.();
		const label = stateText ? `${button.label}  ${stateText}` : button.label;

		ctx.clearRect( 0, 0, CANVAS_W, CANVAS_H );

		const r = 34;
		ctx.beginPath();
		ctx.moveTo( r, 8 );
		ctx.arcTo( CANVAS_W - 8, 8, CANVAS_W - 8, CANVAS_H - 8, r );
		ctx.arcTo( CANVAS_W - 8, CANVAS_H - 8, 8, CANVAS_H - 8, r );
		ctx.arcTo( 8, CANVAS_H - 8, 8, 8, r );
		ctx.arcTo( 8, 8, CANVAS_W - 8, 8, r );
		ctx.closePath();

		ctx.fillStyle = hovered ? 'rgba(30, 84, 108, 0.95)' : 'rgba(12, 17, 22, 0.88)';
		ctx.fill();
		ctx.lineWidth = hovered ? 5 : 3;
		ctx.strokeStyle = hovered ? '#7ff0ff' : 'rgba(120, 190, 220, 0.45)';
		ctx.stroke();

		ctx.fillStyle = hovered ? '#eafcff' : '#bcd6e2';
		ctx.font = '600 60px system-ui, sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText( label, CANVAS_W / 2, CANVAS_H / 2 + 4 );

	}

	setVisible( visible ) {

		this.group.visible = visible;

	}

	dispose() {

		for ( const button of this.buttons ) {

			button.mesh.geometry.dispose();
			button.mesh.material.dispose();
			button.texture.dispose();

		}

	}

}

export const MENU_METRICS = { BTN_W, BTN_H, BTN_GAP };
