/**
 * PartTooltip.js
 * ---------------------------------------------------------------------------
 * Floating world-space spec panel for the hovered / held component.
 *
 * Implementation notes:
 *
 *  - A CanvasTexture on a plane, not HTML. DOM overlays do not exist in
 *    immersive-vr, and a canvas panel is the only thing that is stereoscopic,
 *    occlusion-correct and readable at 0.3 m in a headset.
 *
 *  - The canvas is repainted ONLY when the signature (part id + state) changes.
 *    A 768x440 canvas redraw costs more than the rest of the frame; doing it
 *    every frame would tank the headset's budget for no visual gain.
 *
 *  - Position is damped and offset along a camera-relative direction so the
 *    panel settles beside the part instead of snapping, and never covers the
 *    thing you are looking at.
 *
 *  - `depthTest: false` + a high renderOrder: an inspection panel must not be
 *    clipped by the component it is annotating.
 * ---------------------------------------------------------------------------
 */

import {
	BufferGeometry,
	CanvasTexture,
	Color,
	Float32BufferAttribute,
	Group,
	Line,
	LineBasicMaterial,
	LinearMipmapLinearFilter,
	Mesh,
	MeshBasicMaterial,
	PlaneGeometry,
	SRGBColorSpace,
	Vector3,
} from 'three';

import { clamp, damp } from '../utils/mathUtils.js';

const CANVAS_W = 768;
const CANVAS_H = 440;
const PANEL_W = 0.30;
const PANEL_H = PANEL_W * ( CANVAS_H / CANVAS_W );

const _anchor = /* @__PURE__ */ new Vector3();
const _target = /* @__PURE__ */ new Vector3();
const _camPos = /* @__PURE__ */ new Vector3();
const _right = /* @__PURE__ */ new Vector3();
const _up = /* @__PURE__ */ new Vector3();
const _view = /* @__PURE__ */ new Vector3();

export class PartTooltip {

	/**
	 * @param {Object} [opts]
	 * @param {number} [opts.distance]  Metres from the part to the panel.
	 * @param {number} [opts.maxAnisotropy] From renderer.capabilities.
	 */
	constructor( { distance = 0.24, maxAnisotropy = 4 } = {} ) {

		this.distance = distance;

		this.canvas = this._createCanvas();
		this.ctx = this.canvas.getContext( '2d' );

		this.texture = new CanvasTexture( this.canvas );
		this.texture.colorSpace = SRGBColorSpace;
		this.texture.anisotropy = maxAnisotropy;
		this.texture.minFilter = LinearMipmapLinearFilter;
		this.texture.generateMipmaps = true;

		this.group = new Group();
		this.group.name = 'part-tooltip';
		this.group.visible = false;

		this.panel = new Mesh(
			new PlaneGeometry( PANEL_W, PANEL_H ),
			new MeshBasicMaterial( {
				map: this.texture,
				transparent: true,
				opacity: 0,
				depthTest: false,
				depthWrite: false,
				toneMapped: false,
				side: 2, // DoubleSide — readable when you walk around the model
			} )
		);
		this.panel.renderOrder = 20;
		this.panel.name = 'tooltip-panel';

		// Leader line: part -> panel. Two points, updated in place.
		this.lineGeometry = new BufferGeometry();
		this.lineGeometry.setAttribute( 'position', new Float32BufferAttribute( new Float32Array( 6 ), 3 ) );
		this.line = new Line(
			this.lineGeometry,
			new LineBasicMaterial( {
				color: 0x46d3ff,
				transparent: true,
				opacity: 0,
				depthTest: false,
				toneMapped: false,
			} )
		);
		this.line.renderOrder = 19;
		this.line.frustumCulled = false;

		this.group.add( this.panel, this.line );

		/** @type {?import('../machine/MachinePart.js').MachinePart} */
		this.part = null;
		this._signature = '';
		this._opacity = 0;
		this._placed = false;

	}

	_createCanvas() {

		// document is unavailable in Node; the headless tests exercise paint()
		// through a stub canvas instead of constructing this class.
		const canvas = typeof document !== 'undefined'
			? document.createElement( 'canvas' )
			: { width: CANVAS_W, height: CANVAS_H, getContext: () => null };

		canvas.width = CANVAS_W;
		canvas.height = CANVAS_H;
		return canvas;

	}

	/** Attach to a part. Cheap to call every frame — repaints only on change. */
	show( part ) {

		this.part = part;

	}

	hide() {

		this.part = null;

	}

	/**
	 * @param {number} dt
	 * @param {import('three').Camera} camera  XR camera in immersive sessions.
	 * @param {boolean} [held]                 Shows the "HELD" pill.
	 */
	update( dt, camera, held = false ) {

		const part = this.part;
		const want = part ? 1 : 0;

		this._opacity = damp( this._opacity, want, 14, dt );

		if ( this._opacity < 0.01 ) {

			this.group.visible = false;
			return;

		}

		this.group.visible = true;
		this.panel.material.opacity = this._opacity;
		this.line.material.opacity = this._opacity * 0.75;

		if ( ! part ) return;

		const signature = `${part.id}|${held ? 'h' : 'n'}`;
		if ( signature !== this._signature ) {

			this._signature = signature;
			this.paint( part, held );
			this.texture.needsUpdate = true;

		}

		if ( this.line.material.color.getHex() !== part.accent.getHex() ) {

			this.line.material.color.copy( part.accent );

		}

		if ( ! camera ) return;

		camera.getWorldPosition( _camPos );

		_anchor.copy( part.anchorOffset ).applyMatrix4( part.group.matrixWorld );

		/* Place the panel to the side of the part that faces the viewer, biased
		   up and out so it never overlaps the component it describes. */
		_view.subVectors( _camPos, _anchor ).normalize();
		_right.crossVectors( _view, camera.up ).normalize();
		if ( _right.lengthSq() < 1e-6 ) _right.set( 1, 0, 0 );
		_up.crossVectors( _right, _view ).normalize();

		_target.copy( _anchor )
			.addScaledVector( _right, this.distance * 0.95 )
			.addScaledVector( _up, this.distance * 0.42 )
			.addScaledVector( _view, this.distance * 0.25 );

		// First frame snaps; afterwards it glides.
		if ( ! this._placed ) {

			this.group.position.copy( _target );
			this._placed = true;

		} else {

			this.group.position.lerp( _target, 1 - Math.exp( - 10 * dt ) );

		}

		this.group.quaternion.copy( camera.quaternion );

		const pos = this.lineGeometry.attributes.position;
		pos.setXYZ( 0, _anchor.x, _anchor.y, _anchor.z );
		pos.setXYZ( 1, this.group.position.x, this.group.position.y, this.group.position.z );
		pos.needsUpdate = true;

	}

	/* ------------------------------------------------------------------ *
	 * Canvas painting
	 * ------------------------------------------------------------------ */

	/**
	 * Draw the panel for a part.
	 * Exported behaviour is driven by pure layout values so it can be
	 * regression-tested without a browser.
	 */
	paint( part, held = false ) {

		const ctx = this.ctx;
		if ( ! ctx ) return;

		const meta = part.meta ?? {};
		const accent = `#${part.accent.getHexString()}`;

		ctx.clearRect( 0, 0, CANVAS_W, CANVAS_H );

		// Card
		this._roundRect( ctx, 6, 6, CANVAS_W - 12, CANVAS_H - 12, 22 );
		ctx.fillStyle = 'rgba(9, 12, 16, 0.92)';
		ctx.fill();
		ctx.lineWidth = 2;
		ctx.strokeStyle = this._withAlpha( accent, 0.55 );
		ctx.stroke();

		// Accent spine
		ctx.fillStyle = accent;
		this._roundRect( ctx, 6, 6, 10, CANVAS_H - 12, 6 );
		ctx.fill();

		// State pill
		const pill = held ? 'HELD' : 'NEAR';
		ctx.font = '600 24px system-ui, sans-serif';
		const pillW = ctx.measureText( pill ).width + 34;
		this._roundRect( ctx, CANVAS_W - pillW - 30, 28, pillW, 40, 20 );
		ctx.fillStyle = this._withAlpha( accent, 0.18 );
		ctx.fill();
		ctx.fillStyle = accent;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'center';
		ctx.fillText( pill, CANVAS_W - pillW / 2 - 30, 49 );
		ctx.textAlign = 'left';

		// Title
		ctx.textBaseline = 'alphabetic';
		ctx.fillStyle = '#f2f7fb';
		ctx.font = '700 42px system-ui, sans-serif';
		ctx.fillText( this._fit( ctx, part.name, CANVAS_W - pillW - 100 ), 40, 78 );

		// Part number / material
		ctx.fillStyle = '#8ba0ae';
		ctx.font = '400 25px system-ui, sans-serif';
		const sub = [ meta.partNo, meta.material ].filter( Boolean ).join( '  ·  ' );
		ctx.fillText( this._fit( ctx, sub, CANVAS_W - 80 ), 40, 116 );

		// Divider
		ctx.strokeStyle = 'rgba(140, 170, 190, 0.22)';
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo( 40, 140 );
		ctx.lineTo( CANVAS_W - 40, 140 );
		ctx.stroke();

		// Spec grid (two columns)
		const specs = meta.specs ?? [];
		const colX = [ 40, CANVAS_W / 2 + 8 ];
		const rowY = 178;
		const rowH = 40;

		specs.slice( 0, 6 ).forEach( ( [ label, value ], i ) => {

			const col = i % 2;
			const row = Math.floor( i / 2 );
			const x = colX[ col ];
			const y = rowY + row * rowH;

			ctx.fillStyle = '#7d929f';
			ctx.font = '400 23px system-ui, sans-serif';
			ctx.fillText( this._fit( ctx, label.toUpperCase(), 300 ), x, y );

			ctx.fillStyle = '#e6f1f8';
			ctx.font = '600 26px system-ui, sans-serif';
			ctx.fillText( this._fit( ctx, String( value ), 320 ), x, y + 28 );

		} );

		// Description
		if ( meta.description ) {

			const descY = rowY + Math.ceil( Math.min( specs.length, 6 ) / 2 ) * rowH + 26;
			ctx.fillStyle = '#a9bcc8';
			ctx.font = '400 24px system-ui, sans-serif';
			this._wrap( ctx, meta.description, 40, descY, CANVAS_W - 80, 30, 3 );

		}

		// Mass, bottom right
		if ( meta.mass ) {

			ctx.fillStyle = '#63798a';
			ctx.font = '400 22px system-ui, sans-serif';
			ctx.textAlign = 'right';
			ctx.fillText( meta.mass, CANVAS_W - 40, CANVAS_H - 30 );
			ctx.textAlign = 'left';

		}

	}

	_roundRect( ctx, x, y, w, h, r ) {

		const rr = Math.min( r, w / 2, h / 2 );
		ctx.beginPath();
		ctx.moveTo( x + rr, y );
		ctx.arcTo( x + w, y, x + w, y + h, rr );
		ctx.arcTo( x + w, y + h, x, y + h, rr );
		ctx.arcTo( x, y + h, x, y, rr );
		ctx.arcTo( x, y, x + w, y, rr );
		ctx.closePath();

	}

	_withAlpha( hex, alpha ) {

		const c = new Color( hex );
		return `rgba(${Math.round( c.r * 255 )}, ${Math.round( c.g * 255 )}, ${Math.round( c.b * 255 )}, ${clamp( alpha, 0, 1 )})`;

	}

	/** Shrink-to-fit: append an ellipsis instead of overflowing the card. */
	_fit( ctx, text, maxWidth ) {

		if ( ctx.measureText( text ).width <= maxWidth ) return text;
		let out = text;
		while ( out.length > 1 && ctx.measureText( `${out}…` ).width > maxWidth ) out = out.slice( 0, - 1 );
		return `${out}…`;

	}

	_wrap( ctx, text, x, y, maxWidth, lineHeight, maxLines ) {

		const words = String( text ).split( /\s+/ );
		let line = '';
		let lines = 0;

		for ( const word of words ) {

			const test = line ? `${line} ${word}` : word;
			if ( ctx.measureText( test ).width > maxWidth && line ) {

				ctx.fillText( line, x, y + lines * lineHeight );
				line = word;
				lines ++;
				if ( lines >= maxLines - 1 ) break;

			} else {

				line = test;

			}

		}

		if ( lines < maxLines && line ) ctx.fillText( line, x, y + lines * lineHeight );

	}

	dispose() {

		this.panel.geometry.dispose();
		this.panel.material.dispose();
		this.lineGeometry.dispose();
		this.line.material.dispose();
		this.texture.dispose();

	}

}

export const TOOLTIP_CANVAS_SIZE = { CANVAS_W, CANVAS_H, PANEL_W, PANEL_H };
