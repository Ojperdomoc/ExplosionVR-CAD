/**
 * Stage.js
 * ---------------------------------------------------------------------------
 * The room: grid floor, shadow catcher, inspection plinth, gradient backdrop.
 *
 * The floor is three cooperating layers rather than one clever material:
 *
 *   1. floor      MeshStandardMaterial, receives shadows, picks up the IBL so
 *                 the machine has something to reflect into.
 *   2. grid       a shader plane 1.5 mm above it — anti-aliased with fwidth(),
 *                 faded radially so it dissolves into the dark instead of
 *                 ending in a visible edge. Transparent, depthWrite off, so it
 *                 blends over the floor without z-fighting.
 *   3. plinth     the machined base the assembly is bolted to. Grounding the
 *                 model matters in VR: without a support object, a floating
 *                 machine reads as a hologram and users misjudge its scale.
 * ---------------------------------------------------------------------------
 */

import {
	BackSide,
	Color,
	CylinderGeometry,
	Group,
	Mesh,
	MeshStandardMaterial,
	PlaneGeometry,
	ShaderMaterial,
	SphereGeometry,
	Vector3,
} from 'three';

const GRID_VERTEX = /* glsl */`
	varying vec3 vWorld;
	void main() {
		vec4 world = modelMatrix * vec4( position, 1.0 );
		vWorld = world.xyz;
		gl_Position = projectionMatrix * viewMatrix * world;
	}
`;

const GRID_FRAGMENT = /* glsl */`
	uniform vec3  uMinor;
	uniform vec3  uMajor;
	uniform float uFade;
	uniform float uOpacity;
	varying vec3 vWorld;

	// Anti-aliased grid: divide the distance to the nearest line by the screen
	// space derivative so a line stays one pixel wide at any distance or angle.
	float gridMask( vec2 p, float scale ) {
		vec2 c = p / scale;
		vec2 g = abs( fract( c - 0.5 ) - 0.5 ) / fwidth( c );
		return 1.0 - min( min( g.x, g.y ), 1.0 );
	}

	void main() {
		vec2 p = vWorld.xz;

		float minor = gridMask( p, 0.10 );
		float major = gridMask( p, 1.00 );

		float dist = length( p );
		float fade = 1.0 - smoothstep( uFade * 0.35, uFade, dist );

		vec3 colour = uMinor * minor * 0.55 + uMajor * major;
		float alpha = ( minor * 0.35 + major * 0.85 ) * fade * uOpacity;

		if ( alpha < 0.004 ) discard;
		gl_FragColor = vec4( colour, alpha );
	}
`;

const BACKDROP_VERTEX = /* glsl */`
	varying vec3 vDir;
	void main() {
		vDir = normalize( position );
		gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
	}
`;

const BACKDROP_FRAGMENT = /* glsl */`
	uniform vec3 uTop;
	uniform vec3 uBottom;
	uniform vec3 uHorizon;
	varying vec3 vDir;
	void main() {
		float h = clamp( vDir.y * 0.5 + 0.5, 0.0, 1.0 );
		vec3 c = mix( uBottom, uTop, smoothstep( 0.35, 0.95, h ) );
		c = mix( c, uHorizon, pow( 1.0 - abs( vDir.y ), 8.0 ) * 0.55 );
		gl_FragColor = vec4( c, 1.0 );
	}
`;

export class Stage {

	/**
	 * @param {Object} [opts]
	 * @param {number} [opts.floorSize]   Metres across.
	 * @param {number} [opts.plinthTop]   Height of the plinth top surface.
	 * @param {boolean}[opts.plinth]      Build the plinth at all.
	 */
	constructor( { floorSize = 30, plinthTop = 0.86, plinth = true } = {} ) {

		this.group = new Group();
		this.group.name = 'stage';

		/* --- 1. floor ------------------------------------------------- */

		this.floor = new Mesh(
			new PlaneGeometry( floorSize, floorSize ),
			new MeshStandardMaterial( {
				color: 0x0a0d11,
				roughness: 0.72,
				metalness: 0.22,
			} )
		);
		this.floor.rotation.x = - Math.PI / 2;
		this.floor.receiveShadow = true;
		this.floor.name = 'floor';

		/* --- 2. grid -------------------------------------------------- */

		this.gridMaterial = new ShaderMaterial( {
			vertexShader: GRID_VERTEX,
			fragmentShader: GRID_FRAGMENT,
			uniforms: {
				uMinor: { value: new Color( 0x2b4d5c ) },
				uMajor: { value: new Color( 0x4f93ad ) },
				uFade: { value: floorSize * 0.42 },
				uOpacity: { value: 1 },
			},
			transparent: true,
			depthWrite: false,
		} );

		this.grid = new Mesh( new PlaneGeometry( floorSize, floorSize ), this.gridMaterial );
		this.grid.rotation.x = - Math.PI / 2;
		this.grid.position.y = 0.0015;
		this.grid.name = 'grid';

		/* --- 3. plinth ------------------------------------------------ */

		this.plinth = null;
		if ( plinth ) {

			this.plinth = new Group();
			this.plinth.name = 'plinth';

			// Slim tapered pedestal: a fat drum reads as "machine on a barrel".
			// The top plate, not the column, is what grounds the assembly.
			const body = new Mesh(
				new CylinderGeometry( 0.14, 0.22, plinthTop - 0.03, 48, 1 ),
				new MeshStandardMaterial( { color: 0x14181d, roughness: 0.62, metalness: 0.45 } )
			);
			body.position.y = ( plinthTop - 0.03 ) / 2;
			body.castShadow = true;
			body.receiveShadow = true;

			const plate = new Mesh(
				new CylinderGeometry( 0.30, 0.32, 0.028, 48 ),
				new MeshStandardMaterial( { color: 0x22282f, roughness: 0.38, metalness: 0.75 } )
			);
			plate.position.y = plinthTop - 0.014;
			plate.castShadow = true;
			plate.receiveShadow = true;

			const foot = new Mesh(
				new CylinderGeometry( 0.26, 0.30, 0.02, 48 ),
				new MeshStandardMaterial( { color: 0x0e1114, roughness: 0.8, metalness: 0.3 } )
			);
			foot.position.y = 0.01;
			foot.receiveShadow = true;

			this.plinth.add( body, plate, foot );
			this.group.add( this.plinth );

		}

		/* --- 4. backdrop ---------------------------------------------- */

		this.backdrop = new Mesh(
			new SphereGeometry( 40, 32, 16 ),
			new ShaderMaterial( {
				vertexShader: BACKDROP_VERTEX,
				fragmentShader: BACKDROP_FRAGMENT,
				uniforms: {
					uTop: { value: new Color( 0x0b1015 ) },
					uBottom: { value: new Color( 0x040608 ) },
					uHorizon: { value: new Color( 0x122530 ) },
				},
				side: BackSide,
				depthWrite: false,
			} )
		);
		this.backdrop.name = 'backdrop';
		this.backdrop.frustumCulled = false;

		this.group.add( this.floor, this.grid, this.backdrop );

		this.plinthTop = plinth ? plinthTop : 0;

	}

	/** World position the assembly should be mounted at. */
	mountPoint( out = new Vector3() ) {

		return out.set( 0, this.plinthTop + 0.12, 0 );

	}

	setGridOpacity( value ) {

		this.gridMaterial.uniforms.uOpacity.value = value;

	}

	dispose() {

		this.group.traverse( ( object ) => {

			if ( object.isMesh ) {

				object.geometry.dispose();
				const material = object.material;
				if ( Array.isArray( material ) ) material.forEach( ( m ) => m.dispose() );
				else material.dispose();

			}

		} );

	}

}
