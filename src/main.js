/**
 * main.js
 * ---------------------------------------------------------------------------
 * Entry point: parse options, build the app, wire the keyboard.
 *
 * Query parameters
 *   ?model=1        start on the second assembly in the registry
 *   ?hdri=<url>     use a real HDRI instead of the generated room environment
 *   ?hands=0        start with the puppet hands hidden
 * ---------------------------------------------------------------------------
 */

import { App, ASSEMBLIES } from './core/App.js';
import { HudOverlay } from './ui/HudOverlay.js';

const params = new URLSearchParams( window.location.search );

const canvas = document.getElementById( 'scene' );
const bootError = document.getElementById( 'boot-error' );

const app = new App( {
	canvas,
	hdrUrl: params.get( 'hdri' ) || null,
	assemblyIndex: Number.parseInt( params.get( 'model' ) ?? '0', 10 ) || 0,
} );

const hud = new HudOverlay( app );
app.hud = hud;

async function boot() {

	await app.init();

	await hud.reflectXRCapability();
	hud.setAssembly( app.assembly, app.assemblyIndex, ASSEMBLIES.length );
	hud.setExploded( false );
	hud.setSecondHand( false );
	if ( params.get( 'hands' ) === '0' ) app.setHandsVisible( false );
	if ( params.get( 'camera' ) === '1' ) app.setCamera( true );

	window.addEventListener( 'keydown', ( event ) => {

		if ( event.target instanceof HTMLInputElement ) return;

		switch ( event.key.toLowerCase() ) {

			case 'e':
				app.toggleExplode();
				break;
			case 'r':
				app.reset();
				break;
			case 'l':
				app.setLabels( ! app.tooltipEnabled );
				break;
			case 'h':
				app.setSecondHand( ! app.simProviders?.[ 1 ]?.enabled );
				break;
			case 'g':
				app.setHandsVisible( ! app.handsVisible );
				break;
			case 'c':
				app.setCamera( ! app.cameraProvider?.active );
				break;
			case 'v':
				if ( app.sceneManager?.isPresenting ) app.exitXR();
				else app.enterXR().catch( ( error ) => hud.setXRState( 'error', { message: error?.message } ) );
				break;
			default: {

				// 1..9 -> inspect the nth component.
				const index = Number.parseInt( event.key, 10 );
				if ( index >= 1 && index <= app.assembly.parts.length ) {

					app.focusPart( app.assembly.parts[ index - 1 ] );

				}

			}

		}

	} );

	// Exposed for debugging and for the automated browser test.
	window.__app = app;
	document.body.dataset.ready = 'true';

}

boot().catch( ( error ) => {

	console.error( error );
	if ( bootError ) {

		bootError.hidden = false;
		bootError.textContent = `Initialisation failed: ${error?.message ?? error}`;

	}

} );
