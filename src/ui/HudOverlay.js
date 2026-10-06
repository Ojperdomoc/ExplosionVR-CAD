/**
 * HudOverlay.js
 * ---------------------------------------------------------------------------
 * Desktop HUD.
 *
 * This is a convenience layer for mouse users, not part of the interaction
 * model: every action here is also reachable in-headset through the spatial
 * menu. Nothing in the gesture code reads this object.
 *
 * All DOM lookups are optional-by-design (each accessor no-ops when the element
 * is absent) so the class can be constructed in a headless test without a
 * document.
 * ---------------------------------------------------------------------------
 */

const $ = ( id ) => ( typeof document !== 'undefined' ? document.getElementById( id ) : null );

export class HudOverlay {

	/** @param {import('../core/App.js').App} app */
	constructor( app ) {

		this.app = app;

		this.el = {
			assemblyName: $( 'assembly-name' ),
			assemblyMeta: $( 'assembly-meta' ),
			partCount: $( 'part-count' ),
			partList: $( 'part-list' ),
			hovered: $( 'hovered-name' ),
			held: $( 'held-name' ),
			explodeState: $( 'explode-state' ),
			fps: $( 'hud-fps' ),
			calls: $( 'hud-calls' ),
			tris: $( 'hud-tris' ),
			xr: $( 'xr-state' ),
			handMode: $( 'hand-mode' ),
			btnVR: $( 'btn-vr' ),
			btnExplode: $( 'btn-explode' ),
			btnReset: $( 'btn-reset' ),
			btnLabels: $( 'btn-labels' ),
			btnSecondHand: $( 'btn-second-hand' ),
			btnCamera: $( 'btn-camera' ),
			btnModel: $( 'btn-model' ),
			secondHandBadge: $( 'second-hand-badge' ),
		};

		this._bind();

	}

	_bind() {

		const { app, el } = this;

		el.btnVR?.addEventListener( 'click', async () => {

			try {

				if ( app.sceneManager?.isPresenting ) await app.exitXR();
				else await app.enterXR();

			} catch ( error ) {

				this.setXRState( 'error', { message: error?.message ?? String( error ) } );

			}

		} );

		el.btnExplode?.addEventListener( 'click', () => app.toggleExplode() );
		el.btnReset?.addEventListener( 'click', () => app.reset() );
		el.btnLabels?.addEventListener( 'click', () => app.setLabels( ! app.tooltipEnabled ) );
		el.btnModel?.addEventListener( 'click', () => app.cycleAssembly() );
		el.btnSecondHand?.addEventListener( 'click', () => {

			app.setSecondHand( ! app.simProviders?.[ 1 ]?.enabled );

		} );

		el.btnCamera?.addEventListener( 'click', () => {

			app.setCamera( ! app.cameraProvider?.active );

		} );

	}

	/** Reflect WebXR support in the button, and offer the puppet as the fallback. */
	async reflectXRCapability() {

		const { SceneManager } = await import( '../core/SceneManager.js' );
		const supported = await SceneManager.isXRSupported();

		if ( this.el.btnVR ) {

			this.el.btnVR.textContent = supported ? 'Enter VR' : 'VR unavailable';
			this.el.btnVR.disabled = ! supported;
			this.el.btnVR.title = supported
				? 'Request an immersive-vr session (hand tracking enabled where supported)'
				: 'This browser/device reports no immersive-vr support. The desktop puppet hands remain available.';

		}

		this.setXRState( supported ? 'ready' : 'desktop', null );
		return supported;

	}

	/* ------------------------------------------------------------------ *
	 * State setters
	 * ------------------------------------------------------------------ */

	setAssembly( assembly, index, total ) {

		if ( this.el.assemblyName ) this.el.assemblyName.textContent = assembly.name;
		if ( this.el.assemblyMeta ) this.el.assemblyMeta.textContent = assembly.tagline ?? '';
		if ( this.el.partCount ) this.el.partCount.textContent = `${assembly.parts.length} components`;

		if ( this.el.btnModel ) this.el.btnModel.textContent = `Model ${index + 1}/${total}`;

		const list = this.el.partList;
		if ( ! list ) return;

		list.textContent = '';
		for ( const part of assembly.parts ) {

			const row = document.createElement( 'button' );
			row.type = 'button';
			row.className = 'part-row';
			row.dataset.partId = part.id;

			const swatch = document.createElement( 'span' );
			swatch.className = 'swatch';
			swatch.style.background = `#${part.accent.getHexString()}`;

			const label = document.createElement( 'span' );
			label.className = 'part-label';
			label.textContent = part.name;

			const no = document.createElement( 'span' );
			no.className = 'part-no';
			no.textContent = part.meta?.partNo ?? '';

			row.append( swatch, label, no );

			// Clicking a row "points" the puppet hand at that part, which drives
			// the exact same hover code path as a real fingertip.
			row.addEventListener( 'click', () => this.app.focusPart?.( part ) );

			list.appendChild( row );

		}

	}

	setHovered( part ) {

		if ( this.el.hovered ) this.el.hovered.textContent = part ? part.name : '—';

		this.el.partList?.querySelectorAll( '.part-row' ).forEach( ( row ) => {

			row.classList.toggle( 'is-hovered', !! part && row.dataset.partId === part.id );

		} );

	}

	setHeld( part ) {

		if ( this.el.held ) this.el.held.textContent = part ? part.name : '—';

	}

	setExploded( on ) {

		if ( this.el.explodeState ) this.el.explodeState.textContent = on ? 'exploded' : 'assembled';
		this.el.btnExplode?.classList.toggle( 'is-active', !! on );

	}

	setExplodeLatch( on ) {

		if ( this.el.explodeState ) {

			this.el.explodeState.textContent = on ? 'pulling apart…' : this.el.explodeState.textContent;

		}

	}

	setSecondHand( on ) {

		this.el.btnSecondHand?.classList.toggle( 'is-active', !! on );
		if ( this.el.secondHandBadge ) this.el.secondHandBadge.hidden = ! on;

	}

	setXRState( state, info ) {

		if ( ! this.el.xr ) return;

		const text = {
			ready: 'WebXR ready',
			desktop: 'Desktop mode',
			immersive: info?.handTracking ? 'Immersive · hands' : 'Immersive · controllers',
			error: `XR error: ${info?.message ?? 'unknown'}`,
		}[ state ] ?? state;

		this.el.xr.textContent = text;
		this.el.xr.dataset.state = state;

		if ( state === 'immersive' && this.el.btnVR ) this.el.btnVR.textContent = 'Exit VR';
		if ( state !== 'immersive' && this.el.btnVR && ! this.el.btnVR.disabled ) this.el.btnVR.textContent = 'Enter VR';

	}

	setCameraState( state ) {

		const button = this.el.btnCamera;
		if ( ! button ) return;

		button.classList.toggle( 'is-active', state === 'on' );
		button.textContent = state === 'on' ? 'Camera on' : state === 'error' ? 'Camera denied' : 'Camera';
		button.disabled = state === 'starting';

	}

	setHandMode( text ) {

		if ( this.el.handMode ) this.el.handMode.textContent = text;

	}

	setTelemetry( telemetry, explodeT ) {

		if ( this.el.fps ) this.el.fps.textContent = `${Math.round( telemetry.fps )} fps`;
		if ( this.el.calls ) this.el.calls.textContent = `${telemetry.calls} calls`;
		if ( this.el.tris ) this.el.tris.textContent = `${( telemetry.triangles / 1000 ).toFixed( 0 )}k tris`;
		if ( this.el.explodeState && explodeT > 0.001 && explodeT < 0.999 ) {

			this.el.explodeState.textContent = `${Math.round( explodeT * 100 )}%`;

		}

	}

}
