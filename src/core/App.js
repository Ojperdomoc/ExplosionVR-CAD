/**
 * App.js
 * ---------------------------------------------------------------------------
 * Composition root. Everything above this file is a reusable module; this is
 * where the object graph is assembled and the frame loop is defined.
 *
 * Frame order matters and is fixed:
 *
 *   1. input providers    XR joints (or the desktop puppet) -> HandState
 *   2. interaction        proximity / pinch / grab / explode intent
 *   3. scene graph        parts have moved, so refresh world matrices
 *   4. presentation       hands, tooltip, spatial menu
 *   5. controls + render  (SceneManager owns the actual draw call)
 * ---------------------------------------------------------------------------
 */

import {
	Box3,
	Plane,
	Raycaster,
	Scene,
	Vector2,
	Vector3,
} from 'three';

import { SceneManager } from './SceneManager.js';
import { LightingRig } from './LightingRig.js';
import { Stage } from './Stage.js';

import { createPistonAssembly } from '../machine/pistonAssembly.js';
import { createGearboxAssembly } from '../machine/gearboxAssembly.js';
import { ExplodeController } from '../machine/ExplodeController.js';

import { HandState } from '../interaction/HandState.js';
import { createHandProviders } from '../interaction/XRHandProvider.js';
import { SimHandProvider } from '../interaction/SimHandProvider.js';
import { CameraHandProvider } from '../interaction/CameraHandProvider.js';
import { HandInteractionController } from '../interaction/HandInteractionController.js';

import { HandRenderer } from '../ui/HandRenderer.js';
import { PartTooltip } from '../ui/PartTooltip.js';
import { SpatialMenu } from '../ui/SpatialMenu.js';

import { v1, v2 } from '../utils/scratch.js';
import { clamp } from '../utils/mathUtils.js';

const _box = /* @__PURE__ */ new Box3();
const _fallbackPlane = /* @__PURE__ */ new Plane();
const _aimRay = /* @__PURE__ */ new Raycaster();
const _aimProbe = /* @__PURE__ */ new Vector2();
const _aimNdc = /* @__PURE__ */ new Vector3();

export const ASSEMBLIES = [
	{ id: 'hx2500', label: 'HX-2500 Piston', create: createPistonAssembly },
	{ id: 'pg140', label: 'PG-140 Gearbox', create: createGearboxAssembly },
];

export class App {

	/**
	 * @param {Object} opts
	 * @param {HTMLCanvasElement} opts.canvas
	 * @param {Object} [opts.hud]      HudOverlay instance.
	 * @param {string} [opts.hdrUrl]   Optional HDRI environment.
	 * @param {number} [opts.assemblyIndex]
	 */
	constructor( { canvas, hud = null, hdrUrl = null, assemblyIndex = 0 } ) {

		this.canvas = canvas;
		this.hud = hud;
		this.hdrUrl = hdrUrl;
		this.assemblyIndex = assemblyIndex;

		this.scene = new Scene();
		this.tooltipEnabled = true;
		this.handsVisible = true;

		/** One HandState per hand, shared by the XR and puppet providers. */
		this.hands = [ new HandState( 'left' ), new HandState( 'right' ) ];

		this._center = new Vector3();

	}

	async init() {

		this.stage = new Stage( { plinth: true } );
		this.scene.add( this.stage.group );

		this.mountAssembly( this.assemblyIndex );

		this.sceneManager = new SceneManager( {
			canvas: this.canvas,
			scene: this.scene,
			focus: this._center,
			cameraPosition: this._center.clone().add( new Vector3( 0.52, 0.34, 0.72 ) ),
		} ).init();

		this.lighting = new LightingRig( {
			renderer: this.sceneManager.renderer,
			scene: this.scene,
			focus: this._center,
			hdrUrl: this.hdrUrl,
		} );
		await this.lighting.build();

		/* --- interaction -------------------------------------------- */

		this.explode = new ExplodeController( this.assembly.parts );

		this.tooltip = new PartTooltip( {
			maxAnisotropy: this.sceneManager.renderer.capabilities.getMaxAnisotropy(),
		} );
		this.scene.add( this.tooltip.group );

		// The menu was already built by mountAssembly() during construction.
		this.interaction = new HandInteractionController( {
			hands: this.hands,
			assembly: this.assembly,
			explode: this.explode,
			tooltip: this.tooltip,
			menu: this.menu,
		} );

		this.interaction.onHoverChange = ( part ) => this.hud?.setHovered( part );
		this.interaction.onGrabChange = ( part, held ) => {

			this.hud?.setHeld( held ? part : null );
			this.sceneManager.invalidateShadows();

		};
		this.interaction.onExplodeLatch = ( on ) => this.hud?.setExplodeLatch( on );
		this.interaction.onPulse = ( handIndex, intensity, ms ) => {

			const provider = this.xrProviders?.[ handIndex ];
			provider?.pulse?.( intensity, ms );

		};

		/* --- hands --------------------------------------------------- */

		this.xrProviders = createHandProviders( this.sceneManager.renderer, this.hands );

		// The puppet must raycast the REAL meshes, not the picking proxies.
		// Aiming at a proxy sphere puts the fingertip on the bounding volume of
		// whatever is in front — which for this assembly is nearly always the
		// housing — so the hand could never reach a small or enclosed component.
		const getTargets = () => this.assembly.parts.flatMap( ( part ) => part.meshes );
		const fallbackPlane = () => {

			// Park the puppet at the machine's depth when the ray hits nothing,
			// so the hand stays a believable distance away instead of flying off.
			v1.copy( this._center ).sub( this.sceneManager.camera.position ).normalize();
			return _fallbackPlane.setFromNormalAndCoplanarPoint( v1, this._center );

		};

		this.simProviders = [
			new SimHandProvider( {
				state: this.hands[ 0 ],
				camera: this.sceneManager.camera,
				domElement: this.canvas,
				getTargets,
				fallbackPlane,
				secondary: false,
			} ),
			new SimHandProvider( {
				state: this.hands[ 1 ],
				camera: this.sceneManager.camera,
				domElement: this.canvas,
				getTargets,
				fallbackPlane,
				secondary: true,
			} ),
		];
		this.simProviders[ 1 ].setEnabled( false );

		for ( const provider of this.simProviders ) provider.attach();

		// Webcam tracking: an ordinary browser is not an XR runtime, so this is
		// the only way real hands reach the pipeline on a laptop. Off until the
		// user opts in (permission prompt + model load are both explicit).
		this.cameraProvider = new CameraHandProvider( {
			states: this.hands,
			getCamera: () => this.sceneManager.camera,
		} );

		this.handRenderer = new HandRenderer();
		this.scene.add( this.handRenderer.group );

		/* --- XR lifecycle -------------------------------------------- */

		this.sceneManager.onSessionStart = ( session, info ) => {

			this.cameraProvider?.stop();
			this.hud?.setCameraState?.( 'off' );
			this.hud?.setXRState( 'immersive', info );
			this.hud?.setHandMode( info?.handTracking ? 'hands' : 'controllers' );

		};
		this.sceneManager.onSessionEnd = () => {

			this.hud?.setXRState( 'desktop', null );
			this.hud?.setHandMode( this.cameraProvider?.active ? 'camera' : 'puppet' );
			this.interaction.reset();

		};

		/* --- go -------------------------------------------------------- */

		this.sceneManager.start( ( dt ) => this.tick( dt ) );
		this.sceneManager.invalidateShadows();

		return this;

	}

	/* ------------------------------------------------------------------ *
	 * Assembly management
	 * ------------------------------------------------------------------ */

	/**
	 * Build (or rebuild) the world-space tool menu for the current assembly.
	 *
	 * The menu is parented to the assembly group, so it must be rebuilt whenever
	 * the machine is swapped — otherwise it is either left pointing at a disposed
	 * assembly or, worse, left null while the frame loop calls update() on it.
	 */
	_buildMenu() {

		this.menu?.dispose();

		this.menu = new SpatialMenu( {
			parent: this.assembly.group,
			anchor: this.assembly.menuAnchor,
			buttons: [
				{
					id: 'explode',
					label: 'EXPLODE',
					// Optional chaining: the menu is built before the explode
					// controller exists during the very first mount.
					state: () => ( this.explode?.isExploded ? 'ON' : 'OFF' ),
					onSelect: () => this.toggleExplode(),
				},
				{
					id: 'reset',
					label: 'RESET',
					onSelect: () => this.reset(),
				},
				{
					id: 'labels',
					label: 'PANEL',
					state: () => ( this.tooltipEnabled ? 'ON' : 'OFF' ),
					onSelect: () => this.setLabels( ! this.tooltipEnabled ),
				},
				{
					id: 'model',
					label: 'MODEL',
					state: () => `${this.assemblyIndex + 1}/${ASSEMBLIES.length}`,
					onSelect: () => this.cycleAssembly(),
				},
			],
		} );

		return this.menu;

	}

	mountAssembly( index ) {

		if ( this.assembly ) {

			this.scene.remove( this.assembly.group );
			for ( const part of this.assembly.parts ) part.dispose();

		}

		this.assemblyIndex = ( index + ASSEMBLIES.length ) % ASSEMBLIES.length;
		this.assembly = ASSEMBLIES[ this.assemblyIndex ].create();

		this.assembly.group.position.copy( this.stage.mountPoint( v2 ) );
		this.assembly.group.updateMatrixWorld( true );
		this.scene.add( this.assembly.group );

		// Frame the camera on whatever was actually built rather than on a
		// hard-coded hint, so any assembly dropped into the registry is framed.
		_box.setFromObject( this.assembly.group );
		_box.getCenter( this._center );

		this.lighting?.setFocus( this._center );
		this.sceneManager?.frameOn(
			this._center,
			this._center.clone().add( new Vector3( 0.50, 0.30, 0.70 ) )
		);

		if ( this.explode ) {

			this.explode = new ExplodeController( this.assembly.parts );
			if ( this.interaction ) {

				this.interaction.assembly = this.assembly;
				this.interaction.explode = this.explode;
				this.interaction.reset();

			}

		}

		// Rebuild for the new assembly BEFORE anything else can tick, so the
		// frame loop never sees a menu that belongs to a disposed machine.
		this._buildMenu();

		this.hud?.setAssembly( this.assembly, this.assemblyIndex, ASSEMBLIES.length );

	}

	cycleAssembly() {

		this.mountAssembly( this.assemblyIndex + 1 );
		this.menu?.invalidate();
		this.sceneManager?.invalidateShadows();
		return this.assembly;

	}

	/* ------------------------------------------------------------------ *
	 * Commands
	 * ------------------------------------------------------------------ */

	toggleExplode() {

		const next = this.interaction.toggleExplode();
		this.hud?.setExploded( next );
		this.menu?.invalidate();
		this.sceneManager.invalidateShadows();
		return next;

	}

	setExploded( on ) {

		this.interaction.setExploded( on );
		this.hud?.setExploded( !! on );
		this.menu?.invalidate();
		this.sceneManager.invalidateShadows();

	}

	reset() {

		this.interaction.reset();
		this.hud?.setExploded( false );
		this.hud?.setHeld( null );
		this.menu?.invalidate();
		this.sceneManager.invalidateShadows();

	}

	setLabels( on ) {

		this.tooltipEnabled = !! on;
		this.interaction.tooltip = this.tooltipEnabled ? this.tooltip : null;
		if ( ! this.tooltipEnabled ) this.tooltip.hide();
		this.menu?.invalidate();

	}

	/** Desktop-only: the second puppet hand, for testing two-hand gestures. */
	setSecondHand( on ) {

		this.simProviders?.[ 1 ].setEnabled( !! on );
		if ( ! on ) this.hands[ 1 ].visible = false;
		this.hud?.setSecondHand( !! on );

	}

	/**
	 * Toggle webcam hand tracking. Async because it asks for permission and
	 * loads the ~8 MB landmark model on first use.
	 */
	async setCamera( on ) {

		if ( on && ! this.cameraProvider.active ) {

			try {

				await this.cameraProvider.start();
				for ( const provider of this.simProviders ) provider.setEnabled( false );
				this.hud?.setCameraState( 'on' );
				this.hud?.setHandMode( 'camera' );

			} catch ( error ) {

				console.warn( '[App] camera tracking unavailable:', error?.message ?? error );
				this.hud?.setCameraState( 'error', error );
				return false;

			}

		} else if ( ! on && this.cameraProvider.active ) {

			this.cameraProvider.stop();
			this.simProviders?.[ 0 ].setEnabled( true );
			this.hud?.setCameraState( 'off' );
			this.hud?.setHandMode( 'puppet' );

		}

		return this.cameraProvider.active;

	}

	setHandsVisible( on ) {

		this.handsVisible = !! on;
		this.handRenderer?.setVisible( this.handsVisible );

	}

	/** Point the desktop puppet at a part — same hover path as a real fingertip. */
	focusPart( part ) {

		const provider = this.simProviders?.[ 0 ];
		if ( ! provider || this.sceneManager?.isPresenting ) return false;

		// Aim at a point on the part that is actually visible, not at its
		// bounding-sphere centre: for an irregular component the centre can be
		// empty space, or buried inside a neighbouring one.
		const aim = this.screenPointForPart( part );
		const target = aim?.point ?? ( part.updateWorldSphere(), part.worldSphere.center );

		provider.setEnabled( true );
		provider.targetPoint.copy( target );
		provider.smoothPoint.copy( target );
		return true;

	}

	/**
	 * Find a screen position from which this part is the FIRST thing hit.
	 *
	 * Starts at the projected bounding-sphere centre and spirals outwards in
	 * NDC until a camera ray lands on this part rather than on whatever is in
	 * front of it. Returns null when the part is fully occluded (assembled
	 * piston inside its housing), which callers should treat as "not aimable".
	 *
	 * @returns {?{ndc: {x:number,y:number}, point: Vector3}}
	 */
	screenPointForPart( part ) {

		const camera = this.sceneManager?.camera;
		if ( ! camera ) return null;

		part.updateWorldSphere();
		_aimNdc.copy( part.worldSphere.center ).project( camera );

		const meshes = this.assembly.parts.flatMap( ( p ) => p.meshes );

		const hitAt = ( x, y ) => {

			_aimProbe.set( clamp( x, - 1, 1 ), clamp( y, - 1, 1 ) );
			_aimRay.setFromCamera( _aimProbe, camera );
			_aimRay.near = 0;
			_aimRay.far = 50;

			const hits = _aimRay.intersectObjects( meshes, false );
			if ( hits.length === 0 ) return null;

			// Walk up to the part that owns the surface we actually struck.
			let node = hits[ 0 ].object;
			while ( node && ! node.userData.partId ) node = node.parent;

			return node?.userData.partId === part.id ? hits[ 0 ].point.clone() : null;

		};

		let point = hitAt( _aimNdc.x, _aimNdc.y );
		if ( point ) return { ndc: { x: _aimNdc.x, y: _aimNdc.y }, point };

		for ( let ring = 1; ring <= 8 && ! point; ring ++ ) {

			for ( let a = 0; a < 16 && ! point; a ++ ) {

				const angle = ( a / 16 ) * Math.PI * 2;
				const radius = ring * 0.012;
				point = hitAt(
					_aimNdc.x + Math.cos( angle ) * radius,
					_aimNdc.y + Math.sin( angle ) * radius
				);

			}

		}

		return point ? { ndc: { x: _aimProbe.x, y: _aimProbe.y }, point } : null;

	}

	async enterXR() {

		return this.sceneManager.enterXR();

	}

	async exitXR() {

		return this.sceneManager.exitXR();

	}

	/* ------------------------------------------------------------------ *
	 * Frame
	 * ------------------------------------------------------------------ */

	tick( dt ) {

		const presenting = this.sceneManager.isPresenting;

		/* 1. input */
		for ( const provider of this.xrProviders ) {

			provider.enabled = presenting;
			provider.update();

		}
		if ( presenting ) {

			for ( const provider of this.simProviders ) provider.setEnabled( false );

		} else if ( this.cameraProvider?.active ) {

			// Camera owns both hands; park the puppet so the two never fight.
			for ( const provider of this.simProviders ) provider.setEnabled( false );
			this.cameraProvider.update( dt );

		} else {

			for ( const provider of this.simProviders ) provider.update( dt );

		}

		/* 2. interaction (also advances the exploded view) */
		const result = this.interaction.update( dt );

		/* 3. world matrices for anything that moved */
		this.assembly.group.updateMatrixWorld( true );

		if ( result.moved || this.explode.dirty ) this.sceneManager.invalidateShadows();

		/* 4. presentation */
		this.handRenderer.update( this.hands, dt, this.sceneManager.activeCamera );
		this.tooltip.update( dt, this.sceneManager.activeCamera, this.interaction.grab.isGrabbing );
		this.menu?.update( this.hands, dt, this.sceneManager.activeCamera );

		/* 5. desktop camera */
		if ( ! presenting ) this.sceneManager.controls.update();

		this.hud?.setTelemetry( this.sceneManager.telemetry, this.explode.t );

	}

	dispose() {

		this.cameraProvider?.dispose();
		for ( const provider of this.simProviders ?? [] ) provider.dispose();
		this.interaction?.dispose();
		this.handRenderer?.dispose();
		this.tooltip?.dispose();
		this.menu?.dispose();
		this.lighting?.dispose();
		this.stage?.dispose();
		this.sceneManager?.dispose();

	}

}
