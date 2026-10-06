/**
 * LightingRig.js
 * ---------------------------------------------------------------------------
 * Lighting for machined metal.
 *
 * Metals have almost no diffuse response — a bare directional light makes steel
 * look like grey plastic. What sells the material is the ENVIRONMENT: an image
 * based light gives the reflections something to contain, and the specular
 * highlights then carry the shape.
 *
 * Setup, in order of importance:
 *   1. IBL environment (PMREM) — reflections + ambient tint
 *   2. one shadow-casting key light — form and contact shadows
 *   3. a cool rim light — separates the part from the dark background
 *   4. a low hemisphere fill — keeps the shadows from going to pure black
 *
 * The default environment is generated from three's RoomEnvironment and passed
 * through PMREMGenerator, so there is no .hdr download and no CORS exposure.
 * Pass `hdrUrl` to use a real HDRI instead (studio lighting reads even better
 * on chrome); it is prefiltered through the same PMREM path.
 * ---------------------------------------------------------------------------
 */

import {
	AmbientLight,
	ACESFilmicToneMapping,
	Color,
	DirectionalLight,
	HemisphereLight,
	PointLight,
	PMREMGenerator,
	SRGBColorSpace,
	Vector3,
} from 'three';

import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export class LightingRig {

	/**
	 * @param {Object} opts
	 * @param {import('three').WebGLRenderer} opts.renderer
	 * @param {import('three').Scene} opts.scene
	 * @param {Vector3} [opts.focus]       Point the key light's shadow camera looks at.
	 * @param {?string} [opts.hdrUrl]      Optional .hdr / RGBE environment map.
	 * @param {number} [opts.exposure]
	 * @param {number} [opts.shadowMapSize]
	 */
	constructor( {
		renderer,
		scene,
		focus = new Vector3( 0, 1, 0 ),
		hdrUrl = null,
		exposure = 1.05,
		shadowMapSize = 2048,
	} ) {

		this.renderer = renderer;
		this.scene = scene;
		this.focus = focus.clone();
		this.hdrUrl = hdrUrl;

		renderer.toneMapping = ACESFilmicToneMapping;
		renderer.toneMappingExposure = exposure;
		renderer.outputColorSpace = SRGBColorSpace;

		/* --- key light: the only shadow caster ------------------------ */

		this.key = new DirectionalLight( 0xfff4e6, 2.9 );
		this.key.position.set( 1.5, 2.7, 1.3 );
		this.key.castShadow = true;
		this.key.shadow.mapSize.set( shadowMapSize, shadowMapSize );

		// Tight ortho frustum around the machine. Shadow resolution is fixed, so
		// every metre you add to this box costs detail on the part itself.
		const d = 0.85;
		this.key.shadow.camera.left = - d;
		this.key.shadow.camera.right = d;
		this.key.shadow.camera.top = d;
		this.key.shadow.camera.bottom = - d;
		this.key.shadow.camera.near = 0.5;
		this.key.shadow.camera.far = 8;
		this.key.shadow.bias = - 0.0004;
		this.key.shadow.normalBias = 0.018;
		this.key.shadow.radius = 3;

		this.key.target.position.copy( this.focus );

		/* --- cool rim: edge definition against the dark background ---- */

		this.rim = new DirectionalLight( 0x7fc4ff, 1.5 );
		this.rim.position.set( - 2.1, 1.4, - 1.7 );

		/* --- fill ------------------------------------------------ */

		this.hemi = new HemisphereLight( 0x9fc4d8, 0x0d1116, 0.45 );
		this.ambient = new AmbientLight( 0xffffff, 0.12 );

		// Warm practical, close to the machine, to break up the uniform IBL.
		this.accent = new PointLight( 0xffb066, 1.6, 3.2, 2 );
		this.accent.position.set( this.focus.x + 0.45, this.focus.y + 0.55, this.focus.z + 0.55 );

		scene.add( this.key, this.key.target, this.rim, this.hemi, this.ambient, this.accent );

		this._pmrem = null;
		this._envRT = null;

	}

	/**
	 * Build the environment map. Safe to await; falls back to the generated
	 * room if the HDRI fails to load so the scene is never left unlit.
	 */
	async build() {

		this._pmrem = new PMREMGenerator( this.renderer );
		this._pmrem.compileEquirectangularShader();

		if ( this.hdrUrl ) {

			try {

				const { RGBELoader } = await import( 'three/addons/loaders/RGBELoader.js' );
				const texture = await new RGBELoader().loadAsync( this.hdrUrl );
				this._envRT = this._pmrem.fromEquirectangular( texture );
				texture.dispose();

			} catch ( error ) {

				console.warn( `[LightingRig] HDRI "${this.hdrUrl}" failed, using generated room:`, error?.message ?? error );
				this._envRT = this._pmrem.fromScene( new RoomEnvironment(), 0.035 );

			}

		} else {

			const room = new RoomEnvironment();
			this._envRT = this._pmrem.fromScene( room, 0.035 );
			room.traverse( ( o ) => {

				if ( o.isMesh ) {

					o.geometry.dispose();
					if ( Array.isArray( o.material ) ) o.material.forEach( ( m ) => m.dispose() );
					else o.material.dispose();

				}

			} );

		}

		this.scene.environment = this._envRT.texture;

		// The generated room is a bright white box; keep the *background* dark and
		// let the environment do the reflecting only.
		this.scene.background = new Color( 0x070a0d );

		this._pmrem.dispose();
		this._pmrem = null;

		return this;

	}

	/** Re-aim the shadow camera (e.g. after loading a different assembly). */
	setFocus( point ) {

		this.focus.copy( point );
		this.key.target.position.copy( point );
		this.key.target.updateMatrixWorld();
		this.accent.position.set( point.x + 0.45, point.y + 0.55, point.z + 0.55 );

	}

	setExposure( value ) {

		this.renderer.toneMappingExposure = value;

	}

	dispose() {

		this._envRT?.dispose();
		this.scene.environment = null;
		for ( const light of [ this.key, this.rim, this.hemi, this.ambient, this.accent ] ) {

			this.scene.remove( light );

		}

	}

}
