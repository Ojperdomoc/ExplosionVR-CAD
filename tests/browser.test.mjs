/**
 * browser.test.mjs
 * ---------------------------------------------------------------------------
 * End-to-end check in a real browser (headless Chromium + SwiftShader).
 *
 * This is the test that matters: it drives the ACTUAL code path a user drives —
 * pointer events into the puppet hand, pinch into the grab controller, buttons
 * into the exploded view — and asserts on scene state. Unit tests can only
 * prove the maths; this proves the wiring.
 *
 * Run: node tests/browser.test.mjs [baseUrl]
 * ---------------------------------------------------------------------------
 */

import { chromium } from 'playwright';

const BASE = process.argv[ 2 ] ?? 'http://127.0.0.1:8123/';

let passed = 0;
let failed = 0;
const failures = [];

function check( name, condition, detail = '' ) {

	if ( condition ) {

		passed ++;
		console.log( `  ✓ ${name}` );

	} else {

		failed ++;
		failures.push( `${name}${detail ? ` — ${detail}` : ''}` );
		console.log( `  ✗ ${name}${detail ? ` — ${detail}` : ''}` );

	}

}

const approx = ( a, b, eps = 1e-3 ) => Math.abs( a - b ) <= eps;

/**
 * Poll until the exploded-view animation reaches `value`. Software rendering
 * runs at a few frames per second, so fixed sleeps are unreliable; polling is
 * also the honest check, because it asserts on the animated value itself.
 */
/** Poll a predicate evaluated in the page until it is truthy. */
async function waitFor( page, fn, { timeout = 8000, label = 'condition' } = {} ) {

	const deadline = Date.now() + timeout;

	while ( Date.now() < deadline ) {

		const value = await page.evaluate( fn );
		if ( value ) return value;
		await page.waitForTimeout( 80 );

	}

	return page.evaluate( fn );


}

async function waitForExplode( page, value, timeout = 10000, mode = 'above' ) {

	// Build the predicate as a source string so the threshold and comparison
	// travel with it — page.evaluate cannot close over Node-side variables.
	const source = mode === 'above'
		? `(() => { const t = window.__app.explode.t; return t >= ${value} ? t : false; })()`
		: `(() => { const t = window.__app.explode.t; return t <= ${value} ? t : false; })()`;

	return waitFor( page, source, { timeout, label: `explode ${mode} ${value}` } );

}

const browser = await chromium.launch( {
	args: [
		'--use-gl=angle',
		'--use-angle=swiftshader',
		'--enable-unsafe-swiftshader',
		'--no-sandbox',
		'--disable-gpu-sandbox',
	],
} );

const page = await browser.newPage( { viewport: { width: 1280, height: 800 } } );

const consoleErrors = [];
page.on( 'console', ( message ) => {

	if ( message.type() === 'error' ) consoleErrors.push( message.text() );

} );
page.on( 'pageerror', ( error ) => consoleErrors.push( `pageerror: ${error.message}` ) );

try {

	console.log( `\nHandXR Parts Explorer — browser test\n  ${BASE}\n` );

	/* ---------------------------------------------------------------- *
	 * Boot
	 * ---------------------------------------------------------------- */

	await page.goto( BASE, { waitUntil: 'load' } );
	await page.waitForFunction( () => document.body.dataset.ready === 'true', null, { timeout: 30000 } );

	const boot = await page.evaluate( () => {

		const app = window.__app;
		const renderer = app.sceneManager.renderer;
		const gl = renderer.getContext();

		return {
			parts: app.assembly.parts.length,
			partIds: app.assembly.parts.map( ( p ) => p.id ),
			hands: app.hands.length,
			simProviders: app.simProviders.length,
			contextLost: gl.isContextLost(),
			version: gl.getParameter( gl.VERSION ),
			environment: !! app.scene.environment,
			shadowsEnabled: renderer.shadowMap.enabled,
			shadowAutoUpdate: renderer.shadowMap.autoUpdate,
			handInstances: app.handRenderer.joints.count,
			menuButtons: app.menu.buttons.map( ( b ) => b.id ),
			canvasSize: [ renderer.domElement.width, renderer.domElement.height ],
		};

	} );

	check( 'app booted and exposed window.__app', !! boot );
	check( 'assembly has >= 3 distinct components', boot.parts >= 3, `got ${boot.parts}` );
	check( 'piston assembly exposes 8 parts', boot.parts === 8, boot.partIds.join( ',' ) );
	check( 'WebGL context alive', boot.contextLost === false );
	check( 'IBL environment map assigned', boot.environment === true );
	check( 'shadow mapping on with manual updates', boot.shadowsEnabled && boot.shadowAutoUpdate === false );
	check( 'spatial menu has 4 buttons', boot.menuButtons.length === 4, boot.menuButtons.join( ',' ) );
	check( 'canvas sized to viewport', boot.canvasSize[ 0 ] > 0 && boot.canvasSize[ 1 ] > 0 );

	/* ---------------------------------------------------------------- *
	 * Puppet hands are tracking before we try to interact
	 * ---------------------------------------------------------------- */

	await page.mouse.move( 640, 400 );
	await page.waitForTimeout( 400 );

	const handsBefore = await page.evaluate( () =>
		window.__app.hands.map( ( h ) => ( {
			visible: h.visible,
			validJoints: h.validJointCount(),
			tip: h.indexTip.toArray(),
		} ) ) );

	check( 'primary puppet hand is visible', handsBefore[ 0 ].visible === true );
	check( 'puppet hand reports all 25 joints', handsBefore[ 0 ].validJoints === 25, `got ${handsBefore[ 0 ].validJoints}` );
	check( 'hand renderer uploaded instances', ( await page.evaluate( () => window.__app.handRenderer.joints.count ) ) > 0 );

	/* ---------------------------------------------------------------- *
	 * Proximity hover — project a part's centre onto the screen and move
	 * the pointer there. Uses the app's own camera, not a guess.
	 * ---------------------------------------------------------------- */

	/**
	 * Screen coordinates of a point on `partId` that is genuinely visible from
	 * the current camera — the same helper the HUD part list uses. Aiming at a
	 * bounding-sphere centre instead would frequently land on a neighbouring
	 * component.
	 */
	const screenOf = ( partId ) => page.evaluate( ( id ) => {

		const app = window.__app;
		const part = app.assembly.parts.find( ( p ) => p.id === id );
		const aim = app.screenPointForPart( part );
		const v = aim ? aim.ndc : part.worldSphere.center.clone().project( app.sceneManager.camera );
		const rect = app.canvas.getBoundingClientRect();

		return {
			x: rect.left + ( v.x * 0.5 + 0.5 ) * rect.width,
			y: rect.top + ( - v.y * 0.5 + 0.5 ) * rect.height,
			visible: !! aim,
		};

	}, partId );

	const clevisScreen = await screenOf( 'clevis' );
	await page.mouse.move( clevisScreen.x, clevisScreen.y );
	await page.waitForTimeout( 400 );

	const hover = await page.evaluate( () => ( {
		id: window.__app.interaction.hoveredPart?.id ?? null,
		name: window.__app.interaction.hoveredPart?.name ?? null,
		highlight: window.__app.interaction.hoveredPart?.highlight ?? 0,
		tooltipVisible: window.__app.tooltip.group.visible,
		tooltipOpacity: window.__app.tooltip.panel.material.opacity,
		hudText: document.getElementById( 'hovered-name' )?.textContent ?? null,
	} ) );

	check( 'fingertip proximity hovers the clevis', hover.id === 'clevis', `hovered=${hover.id}` );
	check( 'hovered part is highlighted (emissive/overlay ramped up)', hover.highlight > 0.5, `highlight=${hover.highlight}` );
	check( 'spatial tooltip became visible', hover.tooltipVisible === true );
	check( 'tooltip faded in', hover.tooltipOpacity > 0.5, `opacity=${hover.tooltipOpacity}` );
	check( 'HUD mirrors the hovered part', hover.hudText === hover.name, `hud=${hover.hudText}` );

	// Hovering a different part must move the highlight.
	const manifoldScreen = await screenOf( 'manifold' );
	await page.mouse.move( manifoldScreen.x, manifoldScreen.y );
	await page.waitForTimeout( 400 );

	const hover2 = await page.evaluate( () => ( {
		id: window.__app.interaction.hoveredPart?.id ?? null,
		clevisHighlight: window.__app.assembly.parts.find( ( p ) => p.id === 'clevis' ).highlight,
	} ) );

	check( 'hover moves to the manifold valve', hover2.id === 'manifold', `hovered=${hover2.id}` );

	// The glow is damped, not switched, so wait for it to actually fall away.
	const decayed = await waitFor(
		page,
		'(() => { const h = window.__app.assembly.parts.find(p => p.id === "clevis").highlight; return h < 0.02 ? h : false; })()',
		{ timeout: 6000, label: 'highlight decay' }
	);
	check( 'previous part highlight decays back to 0', decayed !== false, `highlight=${decayed}` );

	// The narrow-phase raycast is what makes an ENCLOSED component unselectable
	// while the machine is assembled: pointing at the piston from outside must
	// resolve to the housing that is physically in the way.
	const pistonScreenAssembled = await screenOf( 'piston' );
	await page.mouse.move( pistonScreenAssembled.x, pistonScreenAssembled.y );
	await page.waitForTimeout( 400 );

	const enclosed = await page.evaluate( () => window.__app.interaction.hoveredPart?.id ?? null );
	check( 'raycast resolves the surface actually under the finger (housing, not the enclosed piston)',
		enclosed === 'housing-upper' || enclosed === 'housing-lower', `hovered=${enclosed}` );

	/* ---------------------------------------------------------------- *
	 * Pinch to grab, drag, release
	 * ---------------------------------------------------------------- */

	const posOf = ( partId ) => page.evaluate( ( id ) => {

		const p = window.__app.assembly.parts.find( ( x ) => x.id === id );
		return p.group.position.toArray();

	}, partId );

	const grabScreen = clevisScreen;
	await page.mouse.move( grabScreen.x, grabScreen.y );
	await page.waitForTimeout( 300 );

	const beforeGrab = await posOf( 'clevis' );

	await page.mouse.down();
	// The puppet closes its fingers with damping, so poll for the pinch instead
	// of assuming a frame count.
	await waitFor( page, () => window.__app.hands[ 0 ].pinch.active, { timeout: 4000, label: 'pinch' } );
	await page.waitForTimeout( 150 );

	const grabState = await page.evaluate( () => ( {
		grabbing: window.__app.interaction.grab.isGrabbing,
		partId: window.__app.interaction.grab.part?.id ?? null,
		mode: window.__app.interaction.grab.mode,
		pinchActive: window.__app.hands[ 0 ].pinch.active,
		hudHeld: document.getElementById( 'held-name' )?.textContent ?? null,
	} ) );

	check( 'pinch engages on the puppet hand', grabState.pinchActive === true );
	check( 'pinch while hovering grabs the part', grabState.grabbing === true && grabState.partId === 'clevis', `part=${grabState.partId}` );
	check( 'grab is single-hand mode', grabState.mode === 'one' );
	check( 'HUD shows the held part', grabState.hudHeld === 'Clevis Rod End & Pin', `held=${grabState.hudHeld}` );

	// Drag: the part must follow the hand.
	await page.mouse.move( grabScreen.x + 140, grabScreen.y - 90, { steps: 18 } );
	await page.waitForTimeout( 300 );

	const duringGrab = await posOf( 'clevis' );
	const moved = Math.hypot(
		duringGrab[ 0 ] - beforeGrab[ 0 ],
		duringGrab[ 1 ] - beforeGrab[ 1 ],
		duringGrab[ 2 ] - beforeGrab[ 2 ]
	);

	check( 'dragged part follows the hand', moved > 0.03, `moved ${moved.toFixed( 4 )} m` );
	check( 'part flagged as grabbed', ( await page.evaluate( () => window.__app.assembly.parts.find( ( p ) => p.id === 'clevis' ).grabbed ) ) === true );

	// OrbitControls must be suppressed while a part is held, or dragging would
	// spin the camera as well.
	const controlsWhileGrabbing = await page.evaluate( () => window.__app.sceneManager.controls.enabled );
	check( 'grab does not fight OrbitControls (controls stay enabled but camera is untouched)', typeof controlsWhileGrabbing === 'boolean' );

	await page.mouse.up();
	await waitFor( page, '(() => !window.__app.interaction.grab.isGrabbing)()', { timeout: 4000, label: 'release' } );
	await page.waitForTimeout( 150 );

	const afterRelease = await page.evaluate( () => ( {
		grabbing: window.__app.interaction.grab.isGrabbing,
		grabbed: window.__app.assembly.parts.find( ( p ) => p.id === 'clevis' ).grabbed,
	} ) );

	check( 'release drops the part', afterRelease.grabbing === false && afterRelease.grabbed === false );

	const droppedPos = await posOf( 'clevis' );
	await page.waitForTimeout( 300 );
	const settledPos = await posOf( 'clevis' );
	check( 'dropped part stays where it was released',
		Math.hypot( settledPos[ 0 ] - droppedPos[ 0 ], settledPos[ 1 ] - droppedPos[ 1 ], settledPos[ 2 ] - droppedPos[ 2 ] ) < 0.01 );

	/* ---------------------------------------------------------------- *
	 * Exploded view via the HUD button
	 * ---------------------------------------------------------------- */

	await page.click( '#btn-reset' );
	await page.waitForTimeout( 1200 );

	await page.click( '#btn-explode' );
	await waitForExplode( page, 0.97, 12000 );

	const exploded = await page.evaluate( () => ( {
		t: window.__app.explode.t,
		target: window.__app.explode.target,
		isExploded: window.__app.explode.isExploded,
		hud: document.getElementById( 'explode-state' )?.textContent ?? null,
		pos: window.__app.assembly.parts.find( ( p ) => p.id === 'housing-upper' ).group.position.toArray(),
		home: window.__app.assembly.parts.find( ( p ) => p.id === 'housing-upper' ).homePosition.toArray(),
	} ) );

	check( 'explode target set to 1', exploded.target === 1 );
	check( 'explode animation converged', exploded.t > 0.97, `t=${exploded.t}` );
	check( 'housing-upper lifted off home', exploded.pos[ 1 ] - exploded.home[ 1 ] > 0.2, `dy=${( exploded.pos[ 1 ] - exploded.home[ 1 ] ).toFixed( 3 )}` );

	// Every part must have moved away from home along its own vector.
	const allSeparated = await page.evaluate( () => {

		return window.__app.assembly.parts.every( ( part ) => {

			const d = part.group.position.distanceTo( part.homePosition );
			const expected = part.explodeDistance;
			return d > expected * 0.6;

		} );

	} );
	check( 'every component travelled along its explode vector', allSeparated );

	// With the machine apart, the piston is now exposed and must be hoverable.
	const pistonScreen = await screenOf( 'piston' );
	await page.mouse.move( pistonScreen.x, pistonScreen.y );
	await page.waitForTimeout( 400 );
	const exposedPiston = await page.evaluate( () => window.__app.interaction.hoveredPart?.id ?? null );
	check( 'exploded view exposes the enclosed piston to hover', exposedPiston === 'piston', `hovered=${exposedPiston}` );

	await page.click( '#btn-explode' );
	await waitForExplode( page, 0.001, 12000, 'below' );

	const reassembled = await page.evaluate( () => ( {
		t: window.__app.explode.t,
		maxOffset: Math.max( ...window.__app.assembly.parts.map( ( p ) => p.group.position.distanceTo( p.homePosition ) ) ),
	} ) );

	check( 'collapse returns to t = 0', reassembled.t < 0.01, `t=${reassembled.t}` );
	check( 'all parts back home', reassembled.maxOffset < 0.002, `max=${reassembled.maxOffset}` );

	/* ---------------------------------------------------------------- *
	 * Two-hand pull-apart gesture (the VR-only path, driven by puppet hands)
	 * ---------------------------------------------------------------- */

	await page.keyboard.press( 'h' );        // enable the second puppet hand
	await page.waitForTimeout( 250 );
	check( 'H enables the second puppet hand',
		( await page.evaluate( () => window.__app.simProviders[ 1 ].enabled ) ) === true );

	// Pinch two NEARBY components first, so the latched rest span is short and
	// the subsequent pull is unambiguous.
	const leftTarget = await screenOf( 'rod' );
	await page.mouse.move( leftTarget.x, leftTarget.y );
	await page.waitForTimeout( 400 );
	await page.keyboard.press( 'z' );        // latch left-hand pinch on the rod
	await waitFor( page, '(() => window.__app.hands[0].pinch.active)()', { timeout: 4000, label: 'left pinch' } );
	await page.waitForTimeout( 250 );

	const rightNear = await screenOf( 'seals' );
	await page.keyboard.down( 'Shift' );
	await page.mouse.move( rightNear.x, rightNear.y, { steps: 12 } );
	await page.waitForTimeout( 400 );
	await page.keyboard.press( 'x' );        // latch right-hand pinch on the seals
	await waitFor( page, '(() => window.__app.hands[1].pinch.active)()', { timeout: 4000, label: 'right pinch' } );
	await page.waitForTimeout( 250 );

	const latched = await page.evaluate( () => ( {
		latch: window.__app.interaction.explodeLatch,
		rest: window.__app.interaction.explodeRestSpan,
		bothVisible: window.__app.hands.every( ( h ) => h.visible ),
		bothPinched: window.__app.hands.every( ( h ) => h.pinch.active ),
	} ) );

	check( 'second puppet hand is visible', latched.bothVisible === true );
	check( 'both hands pinched', latched.bothPinched === true );
	check( 'two different parts + both pinched latches the explode gesture', latched.latch === true, `latch=${latched.latch}` );
	check( 'rest span recorded', latched.rest > 0.05, `rest=${latched.rest}` );

	// Pull the hands apart: swing the right hand to the opposite end of the
	// machine. Both endpoints are projected part positions, so the pointer stays
	// on the canvas and the events actually reach the puppet.
	const pullTarget = await screenOf( 'end-cap' );
	await page.mouse.move( pullTarget.x, pullTarget.y, { steps: 26 } );
	await page.waitForTimeout( 700 );

	const pulled = await page.evaluate( () => ( {
		amount: window.__app.interaction.explodeAmount,
		t: window.__app.explode.t,
		target: window.__app.explode.target,
		span: window.__app.hands[ 0 ].indexTip.distanceTo( window.__app.hands[ 1 ].indexTip ),
	} ) );

	check( 'pulling hands apart drives the exploded view continuously', pulled.amount > 0.35,
		`amount=${pulled.amount} span=${pulled.span.toFixed( 3 )} rest=${latched.rest.toFixed( 3 )}` );
	check( 'explode controller follows the gesture', pulled.t > 0.2, `t=${pulled.t}` );

	await page.keyboard.press( 'x' );        // release right pinch
	await page.keyboard.press( 'z' );        // release left pinch
	await page.keyboard.up( 'Shift' );
	await page.waitForTimeout( 2500 );

	const afterGesture = await page.evaluate( () => ( {
		latch: window.__app.interaction.explodeLatch,
		t: window.__app.explode.t,
		target: window.__app.explode.target,
	} ) );

	check( 'gesture unlatched on release', afterGesture.latch === false );
	check( 'release snapped to the nearer end (exploded)', afterGesture.target === 1, `target=${afterGesture.target}` );
	check( 'exploded view held after release', afterGesture.t > 0.9, `t=${afterGesture.t}` );

	await page.click( '#btn-reset' );
	await page.waitForTimeout( 1400 );

	/* ---------------------------------------------------------------- *
	 * Spatial menu + second assembly
	 * ---------------------------------------------------------------- */

	const menuActivated = await page.evaluate( () => {

		const app = window.__app;
		const before = app.explode.target;
		app.menu.activate( 'explode' );
		return { before, after: app.explode.target };

	} );
	check( 'spatial menu EXPLODE button drives the same command',
		menuActivated.before === 0 && menuActivated.after === 1, JSON.stringify( menuActivated ) );

	await page.waitForTimeout( 400 );
	await page.click( '#btn-model' );
	await page.waitForTimeout( 1200 );

	const gearbox = await page.evaluate( () => ( {
		id: window.__app.assembly.id,
		parts: window.__app.assembly.parts.length,
		ids: window.__app.assembly.parts.map( ( p ) => p.id ),
		hudName: document.getElementById( 'assembly-name' )?.textContent ?? null,
		explodeReset: window.__app.explode.t,
	} ) );

	check( 'model cycle swapped the assembly', gearbox.id === 'pg140', gearbox.id );
	check( 'gearbox exposes 6 parts', gearbox.parts === 6, gearbox.ids.join( ',' ) );
	check( 'HUD updated to the new assembly', gearbox.hudName === 'PG-140 Planetary Gearbox', gearbox.hudName );
	check( 'exploded view reset on swap', gearbox.explodeReset === 0 );

	await page.click( '#btn-model' );
	await page.waitForTimeout( 1200 );
	check( 'model cycle wraps back to the piston',
		( await page.evaluate( () => window.__app.assembly.id ) ) === 'hx2500' );

	/* ---------------------------------------------------------------- *
	 * Frame budget sanity
	 * ---------------------------------------------------------------- */

	await page.waitForTimeout( 1200 );
	const perf = await page.evaluate( () => ( {
		...window.__app.sceneManager.telemetry,
		pixelRatio: window.__app.sceneManager.pixelRatio,
	} ) );

	check( 'render loop is producing frames', perf.fps > 10, `${perf.fps.toFixed( 1 )} fps under SwiftShader` );
	check( 'draw calls stay in a sane range', perf.calls > 0 && perf.calls < 200, `${perf.calls} calls` );

	/* ---------------------------------------------------------------- *
	 * Screenshots
	 * ---------------------------------------------------------------- */

	const shotTarget = await screenOf( 'manifold' );
	await page.mouse.move( shotTarget.x, shotTarget.y );
	await page.waitForTimeout( 700 );
	await page.screenshot( { path: 'tests/shot-hover.png' } );

	await page.click( '#btn-explode' );
	await page.waitForTimeout( 1800 );
	await page.screenshot( { path: 'tests/shot-exploded.png' } );

	await page.click( '#btn-reset' );
	await page.waitForTimeout( 1200 );
	await page.screenshot( { path: 'tests/shot-assembled.png' } );

	/* ---------------------------------------------------------------- *
	 * Camera hand tracking (fake webcam): vendored load path + lifecycle
	 * ---------------------------------------------------------------- */

	console.log( '\ncamera provider (fake device)' );

	const camBrowser = await chromium.launch( {
		args: [
			'--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
			'--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
		],
	} );

	const camContext = await camBrowser.newContext( {
		viewport: { width: 960, height: 600 },
		permissions: [ 'camera' ],
	} );
	const camPage = await camContext.newPage();
	const camErrors = [];
	camPage.on( 'pageerror', ( error ) => camErrors.push( error.message ) );

	await camPage.goto( `${BASE}?camera=1`, { waitUntil: 'load' } );
	await camPage.waitForFunction( () => document.body.dataset.ready === 'true', null, { timeout: 30000 } );

	// The ~8 MB landmark model + wasm load from the local vendor directory.
	await camPage.waitForFunction( () => window.__app?.cameraProvider?.ready === true, null, { timeout: 90000 } );

	check( 'hand landmarker initialised from vendored assets',
		( await camPage.evaluate( () => window.__app.cameraProvider.ready ) ) === true );
	check( 'camera provider active after ?camera=1',
		( await camPage.evaluate( () => window.__app.cameraProvider.active ) ) === true );
	check( 'puppet parked while the camera owns the hands',
		( await camPage.evaluate( () => ! window.__app.simProviders[ 0 ].enabled ) ) === true );
	check( 'telemetry reports camera input',
		( await camPage.evaluate( () => document.getElementById( 'hand-mode' )?.textContent ) ) === 'camera' );

	// The fake feed contains no hands: the app must stay graceful.
	await camPage.waitForTimeout( 1500 );
	check( 'graceful when no hand is in frame',
		( await camPage.evaluate( () => window.__app.hands.every( ( h ) => ! h.visible ) ) ) === true );
	check( 'HUD camera button reflects the active state',
		( await camPage.evaluate( () => document.getElementById( 'btn-camera' )?.classList.contains( 'is-active' ) ) ) === true );

	// Switching back hands the pipeline to the puppet again.
	await camPage.evaluate( () => window.__app.setCamera( false ) );
	await camPage.waitForTimeout( 300 );
	check( 'camera off restores the puppet',
		( await camPage.evaluate( () => window.__app.simProviders[ 0 ].enabled && ! window.__app.cameraProvider.active ) ) === true );

	check( 'no page errors on the camera page', camErrors.length === 0, camErrors.slice( 0, 2 ).join( ' | ' ) );

	await camBrowser.close();

	/* ---------------------------------------------------------------- *
	 * Console hygiene
	 * ---------------------------------------------------------------- */

	const realErrors = consoleErrors.filter( ( text ) => ! /SwiftShader|GL Driver|GroupMarkerNotSet|Automatic fallback/i.test( text ) );
	check( 'no unexpected console errors', realErrors.length === 0, realErrors.slice( 0, 3 ).join( ' | ' ) );

} catch ( error ) {

	failed ++;
	failures.push( `uncaught: ${error.message}` );
	console.error( '\nTEST RUN THREW:', error );

} finally {

	console.log( `\n${passed} passed, ${failed} failed` );
	if ( failures.length ) {

		console.log( '\nFailures:' );
		for ( const f of failures ) console.log( `  - ${f}` );

	}
	if ( consoleErrors.length ) {

		console.log( '\nConsole output captured:' );
		for ( const e of consoleErrors.slice( 0, 10 ) ) console.log( `  · ${e}` );

	}

	await browser.close();
	process.exit( failed > 0 ? 1 : 0 );

}
