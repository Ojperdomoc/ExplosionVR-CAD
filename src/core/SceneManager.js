/**
 * SceneManager.js
 * ---------------------------------------------------------------------------
 * Owns the renderer, camera, XR session and the frame loop.
 *
 * A few decisions worth calling out:
 *
 *  - `shadowMap.autoUpdate = false`. The machine is static unless a part is
 *    being moved or exploded, so the shadow map is re-rendered only when
 *    something actually changed (`invalidateShadows()`). On a Quest this is the
 *    difference between holding 72 Hz and not.
 *
 *  - Reference space is negotiated, not assumed. `local-floor` is requested
 *    first because the plinth and grid are authored against a real floor; if
 *    the runtime does not grant it we fall back to `local` rather than failing
 *    the session.
 *
 *  - `hand-tracking` is an OPTIONAL feature. Requiring it would make the
 *    session fail outright on runtimes without it, and controllers remain a
 *    perfectly good way to look at the machine.
 *
 *  - A tiny adaptive governor trims the render scale if the frame time gets
 *    away from us, and restores it once there is headroom again.
 * ---------------------------------------------------------------------------
 */

import { PerspectiveCamera, Vector3, WebGLRenderer, PCFSoftShadowMap } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// A stalled tab or a GPU-bound frame must not produce a multi-second jump, or
// every damped value in the app would teleport. 1/10 s keeps animations
// wall-clock accurate down to 10 fps; below that the app time-dilates, which is
// the correct trade (smooth-but-slow beats a physics explosion).
const MAX_DT = 1 / 10;

export class SceneManager {

	/**
	 * @param {Object} opts
	 * @param {HTMLCanvasElement} opts.canvas
	 * @param {import('three').Scene} opts.scene
	 * @param {Vector3} [opts.focus]      OrbitControls target / camera aim.
	 * @param {Vector3} [opts.cameraPosition]
	 * @param {number} [opts.fov]
	 * @param {[number,number]} [opts.distanceRange]
	 */
	constructor( {
		canvas,
		scene,
		focus = new Vector3( 0, 1, 0 ),
		cameraPosition = new Vector3( 0.7, 1.35, 1.15 ),
		fov = 55,
		distanceRange = [ 0.3, 6 ],
	} ) {

		this.scene = scene;
		this.focus = focus.clone();

		this.renderer = new WebGLRenderer( {
			canvas,
			antialias: true,
			alpha: false,
			stencil: false,
			powerPreference: 'high-performance',
		} );

		const renderer = this.renderer;
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = PCFSoftShadowMap;
		renderer.shadowMap.autoUpdate = false;     // see header
		renderer.xr.enabled = true;

		this.maxPixelRatio = Math.min( window.devicePixelRatio || 1, 2 );
		this.pixelRatio = this.maxPixelRatio;
		renderer.setPixelRatio( this.pixelRatio );

		this.camera = new PerspectiveCamera( fov, 1, 0.02, 120 );
		this.camera.position.copy( cameraPosition );

		this.controls = new OrbitControls( this.camera, renderer.domElement );
		this.controls.target.copy( this.focus );
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.075;
		this.controls.screenSpacePanning = false;
		this.controls.minDistance = distanceRange[ 0 ];
		this.controls.maxDistance = distanceRange[ 1 ];
		this.controls.maxPolarAngle = Math.PI * 0.495;  // do not go under the floor
		this.controls.update();

		/* --- state ---------------------------------------------------- */

		this.isPresenting = false;
		this.handTrackingActive = false;
		this.session = null;

		this._frameCallback = null;
		this._clock = { last: 0 };
		this._shadowDirty = true;

		this._fps = 60;
		this._fpsAccum = 0;
		this._fpsFrames = 0;
		this._governorTimer = 0;

		this.telemetry = { fps: 60, calls: 0, triangles: 0, dt: 0 };

		this.onSessionStart = null;
		this.onSessionEnd = null;

		this._onResize = this._onResize.bind( this );
		this._resizeObserver = null;

	}

	/* ------------------------------------------------------------------ *
	 * Lifecycle
	 * ------------------------------------------------------------------ */

	init() {

		this._onResize();

		if ( typeof ResizeObserver !== 'undefined' && this.renderer.domElement.parentElement ) {

			this._resizeObserver = new ResizeObserver( () => this._onResize() );
			this._resizeObserver.observe( this.renderer.domElement.parentElement );

		} else {

			window.addEventListener( 'resize', this._onResize );

		}

		return this;

	}

	_onResize() {

		if ( this.isPresenting ) return;   // XR owns the framebuffer while presenting

		const element = this.renderer.domElement;
		const parent = element.parentElement;
		const width = parent?.clientWidth || window.innerWidth;
		const height = parent?.clientHeight || window.innerHeight;

		this.camera.aspect = width / Math.max( height, 1 );
		this.camera.updateProjectionMatrix();
		this.renderer.setSize( width, height, false );
		this.invalidateShadows();

	}

	/**
	 * Begin the render loop.
	 * @param {(dt:number, time:number, frame?:XRFrame)=>void} callback
	 */
	start( callback ) {

		this._frameCallback = callback;
		this._clock.last = performance.now();

		this.renderer.setAnimationLoop( ( time, frame ) => {

			const now = performance.now();
			const dt = Math.min( ( now - this._clock.last ) / 1000, MAX_DT );
			this._clock.last = now;

			this._trackFps( dt );

			if ( this._frameCallback ) this._frameCallback( dt, time, frame );

			// Shadows only when something moved (see header).
			if ( this._shadowDirty ) {

				this.renderer.shadowMap.needsUpdate = true;
				this._shadowDirty = false;

			}

			this.renderer.render( this.scene, this._activeCamera() );

		} );

		return this;

	}

	/** The XR camera while presenting (for billboards), otherwise the desktop camera. */
	_activeCamera() {

		return this.isPresenting ? this.renderer.xr.getCamera() : this.camera;

	}

	get activeCamera() {

		return this._activeCamera();

	}

	/* ------------------------------------------------------------------ *
	 * XR session
	 * ------------------------------------------------------------------ */

	static async isXRSupported() {

		if ( ! ( 'xr' in navigator ) ) return false;
		try {

			return await navigator.xr.isSessionSupported( 'immersive-vr' );

		} catch {

			return false;

		}

	}

	/**
	 * Request an immersive-vr session. `local-floor` is preferred but not
	 * required, and hand tracking is always optional.
	 * @returns {Promise<XRSession>}
	 */
	async enterXR() {

		if ( ! ( 'xr' in navigator ) ) throw new Error( 'WebXR is not available in this browser.' );
		if ( this.session ) return this.session;

		const common = { optionalFeatures: [ 'hand-tracking', 'bounded-floor', 'layers' ] };

		let session = null;
		let referenceSpaceType = 'local-floor';

		try {

			session = await navigator.xr.requestSession( 'immersive-vr', {
				...common,
				requiredFeatures: [ 'local-floor' ],
			} );

		} catch ( error ) {

			console.warn( '[SceneManager] local-floor unavailable, retrying with "local":', error?.message ?? error );
			session = await navigator.xr.requestSession( 'immersive-vr', common );
			referenceSpaceType = 'local';

		}

		this.renderer.xr.setReferenceSpaceType( referenceSpaceType );

		session.addEventListener( 'end', () => this._onSessionEnd() );
		session.addEventListener( 'visibilitychange', () => this.invalidateShadows() );

		await this.renderer.xr.setSession( session );

		this.session = session;
		this.isPresenting = true;
		this.controls.enabled = false;

		// `enabledFeatures` is where a runtime reports what it actually granted.
		const features = session.enabledFeatures ?? [];
		this.handTrackingActive = features.includes( 'hand-tracking' );
		this.referenceSpaceType = referenceSpaceType;

		this.invalidateShadows();
		this.onSessionStart?.( session, { referenceSpaceType, handTracking: this.handTrackingActive, features } );

		return session;

	}

	async exitXR() {

		if ( this.session ) await this.session.end();
		return this;

	}

	_onSessionEnd() {

		this.session = null;
		this.isPresenting = false;
		this.handTrackingActive = false;
		this.controls.enabled = true;
		this._onResize();
		this.invalidateShadows();
		this.onSessionEnd?.();

	}

	/* ------------------------------------------------------------------ *
	 * Frame budget
	 * ------------------------------------------------------------------ */

	invalidateShadows() {

		this._shadowDirty = true;

	}

	_trackFps( dt ) {

		if ( dt <= 0 ) return;

		this._fpsAccum += dt;
		this._fpsFrames ++;

		if ( this._fpsAccum >= 0.5 ) {

			this._fps = this._fpsFrames / this._fpsAccum;
			this.telemetry.fps = this._fps;
			this._fpsAccum = 0;
			this._fpsFrames = 0;
			this._govern();

		}

		this.telemetry.dt = dt;
		this.telemetry.calls = this.renderer.info.render.calls;
		this.telemetry.triangles = this.renderer.info.render.triangles;

	}

	/** Trim render scale when the GPU falls behind; restore it when idle. */
	_govern() {

		this._governorTimer ++;
		if ( this._governorTimer % 4 !== 0 ) return;   // evaluate every ~2 s

		if ( this._fps < 50 && this.pixelRatio > 0.8 ) {

			this.pixelRatio = Math.max( 0.8, this.pixelRatio - 0.25 );
			this.renderer.setPixelRatio( this.pixelRatio );
			this.invalidateShadows();

		} else if ( this._fps > 82 && this.pixelRatio < this.maxPixelRatio ) {

			this.pixelRatio = Math.min( this.maxPixelRatio, this.pixelRatio + 0.25 );
			this.renderer.setPixelRatio( this.pixelRatio );
			this.invalidateShadows();

		}

	}

	/* ------------------------------------------------------------------ *
	 * Framing
	 * ------------------------------------------------------------------ */

	frameOn( target, cameraPosition ) {

		this.focus.copy( target );
		this.controls.target.copy( target );
		if ( cameraPosition ) this.camera.position.copy( cameraPosition );
		this.controls.update();
		this.invalidateShadows();

	}

	dispose() {

		this.renderer.setAnimationLoop( null );
		window.removeEventListener( 'resize', this._onResize );
		this._resizeObserver?.disconnect();
		this.controls.dispose();
		this.renderer.dispose();

	}

}
