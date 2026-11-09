const {app, BrowserWindow} = require('electron');
const {mkdtempSync, readFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
// Each DPR gets its own renderer. Keep Electron alive between windows;
// the finally block owns application shutdown.
app.on('window-all-closed', () => {});
const directory = mkdtempSync(path.join(tmpdir(), 'replay-picking-'));

async function runRenderer(contents, source) {
  // Electron replaces renderer exceptions crossing executeJavaScript with a
  // generic IPC error. Serialize the original stack inside the renderer.
  const result = await contents.executeJavaScript(`(async () => {
    try {
      const value = await (async () => {
${source}
      })();
      return {ok: true, value};
    } catch (error) {
      return {ok: false, error: error?.stack || String(error)};
    }
  })()`);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

app.whenReady().then(async () => {
  let window;
  let stage = 'build renderer harness';
  let targetDpr;
  try {
    const {build} = await import('vite');
    const {default: react} = await import('@vitejs/plugin-react');
    await build({
      configFile: false,
      plugins: [react()],
      logLevel: 'error',
      // Vite library mode leaves NODE_ENV untouched by default. The isolated
      // Electron renderer has no Node process global.
      define: {'process.env.NODE_ENV': JSON.stringify('production')},
      build: {outDir: directory, emptyOutDir: false, minify: false, lib: {entry: path.resolve(__dirname, 'trajectory-picking-harness.ts'), formats: ['iife'], name: 'ReplayPickingCheck', fileName: () => 'harness.js'}},
    });
    const bundle = readFileSync(path.join(directory, 'harness.js'), 'utf8');
    for (const dpr of [1, 2, 3]) {
      targetDpr = dpr;
      stage = 'load test window';
      window = new BrowserWindow({show: false, width: 500, height: 400, webPreferences: {contextIsolation: true, backgroundThrottling: false}});
      window.webContents.on('console-message', event => {
        if (event.level === 'warning' || event.level === 'error') {
          console.error(`[renderer ${event.level}, target DPR=${dpr}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
        }
      });
      await window.loadURL('data:text/html,<html><body></body></html>');
      stage = 'configure device pixel ratio';
      window.webContents.setZoomFactor(1);
      const nativeDpr = await runRenderer(window.webContents, 'return devicePixelRatio;');
      const zoomFactor = dpr / nativeDpr;
      window.webContents.setZoomFactor(zoomFactor);
      await runRenderer(window.webContents, `
        const deadline = performance.now() + 3000;
        while (Math.abs(devicePixelRatio - ${dpr}) > 0.01) {
          if (performance.now() > deadline) throw new Error('Observed DPR ' + devicePixelRatio + ', expected ${dpr}');
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
      `);
      stage = 'initialize renderer harness';
      await runRenderer(window.webContents, bundle);
      stage = 'trajectory picking';
      const result = await runRenderer(window.webContents, 'return runTrajectoryPickingCheck();');
      assert.equal(result.count, 180000);
      assert.equal(result.center.trajectoryIndex, 0);
      assert.equal(result.center.timestamp, 1000);
      assert.deepEqual(result.center.coordinate, [0, 0]);
      assert.equal(result.nearby?.trajectoryIndex, 0, 'Picking radius must reach the nearby trajectory point');
      assert.equal(result.empty, null);
      assert.equal(result.wrongView, null);
      assert.equal(result.hidden, null);
      assert.equal(result.restored?.trajectoryIndex, 0, 'Restored trajectory must be pickable');
      assert.equal(result.wrapped?.trajectoryIndex, 1, 'Picking must reach the adjacent world across the antimeridian');
      assert.equal(result.cleared, null);
      assert.equal(result.annotation?.annotationId, 'route', 'Committed route must be pickable');
      assert.equal(result.trajectoryOnly?.trajectoryIndex, 0, 'Trajectory-only picking must ignore annotations');
      assert.equal(result.hiddenAnnotation, null);
      assert.equal(result.metric?.seriesId, 'test-speed', 'Timeline metric must be pickable');
      assert(Math.abs(result.metric.timestamp - 1500) < 1);
      assert.equal(result.clearedMetric, null);
      assert.equal(result.visualAlphaAfter, 0, "Annotation and metric picking passes must remain invisible");
      assert.equal(result.visualAlpha, 0, 'Picking-only geometry must not alter the visible canvas');
      stage = 'offscreen layer rendering';
      const visible = await runRenderer(window.webContents, 'return runVisibleReplayCheck();');
      assert.equal(visible.width, 128, 'Offline width is independent of monitor DPR'); assert.equal(visible.height, 392);
      for (const [name, color] of [['route', visible.route], ['profile', visible.profile], ['restored', visible.restoredProfile]]) assert(color[1] > 150 && color[2] > 200 && color[3] > 150, name + ' must contain the cyan geometry: ' + JSON.stringify(visible));
      assert(visible.draft[0] > 200 && visible.draft[1] > 150 && visible.draft[3] > 150, 'Editing drafts are visible in the visual pass');
      assert.equal(visible.outside[3], 0);
      assert.equal(visible.hiddenRoute[3], 0); assert.equal(visible.hiddenProfile[3], 0);
      assert(visible.timelineLine[0] > 170 && visible.timelineLine[2] > 220 && visible.timelineLine[3] > 150, 'Timeline line must be purple: ' + JSON.stringify(visible.timelineLine));
      assert(Math.abs(visible.timelineFill[3] - 64) <= 3, 'Timeline fill must use the series opacity: ' + JSON.stringify(visible.timelineFill));
      assert.equal(visible.aboveTimeline[3], 0, 'Timeline fill must remain below the line');
      assert.deepEqual(visible.density, [
        [0, 0, 0, 255], [185, 245, 197, 255], [255, 255, 255, 255],
        [255, 227, 110, 255], [0, 0, 0, 255], [255, 255, 255, 255],
      ], 'Both density rows preserve their bin colors and black empty bins');
      assert.deepEqual(visible.outsideDensity, [[0, 0, 0, 0], [0, 0, 0, 0]], 'Density rows stay inside the layout bounds');
      stage = 'elevation visual handoff';
      const handoff = await runRenderer(window.webContents, 'return runElevationHandoffCheck();');
      assert(handoff.cyan > 10, 'The engine canvas contains the visible elevation curve');
      assert(handoff.opaqueBackground > 100, 'The engine paints the opaque panel background');
      assert(handoff.fallbackHidden && handoff.transparentDOM, 'DOM fallback yields only after GPU drawing completes');
      if (handoff.contextLossSupported) assert(handoff.fallbackRestored, 'Context loss restores the fallback curve');
      stage = 'annotation visual handoff';
      const annotations = await runRenderer(window.webContents, 'return runAnnotationHandoffCheck();');
      for (const color of [annotations.route, annotations.restored]) assert(color[1] > 150 && color[2] > 200 && color[3] > 150, 'Map annotations draw through the default shared Layer graph');
      assert.equal(annotations.placeMarker[3], 0, 'DOM labels retain ownership of committed place markers');
      assert.equal(annotations.hidden[3], 0, 'Hiding annotations clears the shared map visual');
      assert(annotations.photoMarker[0] > 200 && annotations.photoMarker[1] > 170 && annotations.photoMarker[2] < 140 && annotations.photoMarker[3] > 80, 'Photo observations render as yellow points');
      assert.equal(annotations.hiddenPhoto[3], 0, 'Hiding the trajectory clears the photo points');
      assert(annotations.annotationWithPhotosHidden[2] > 200, 'Photo visibility is independent of annotations');
      for (const color of [annotations.handle, annotations.movedHandle]) assert(color[1] > 130 && color[2] > 190 && color[3] > 150, 'Scene handles draw at their original and dragged positions');
      assert.equal(annotations.clearedHandle[3], 0);
      assert.equal(annotations.hiddenHandle[3], 0);
      stage = 'map footprint density handoff';
      const footprint = await runRenderer(window.webContents, 'return runFootprintHandoffCheck();');
      assert(footprint.ownedFirst && footprint.first[1] > footprint.first[0] && footprint.first[3] >= 25 && footprint.first[3] <= 56, 'Deck must draw one mint point in the adjacent world: ' + JSON.stringify(footprint));
      assert(footprint.overlap[3] > footprint.first[3] * 1.5, 'Repeat observations must accumulate before tone mapping');
      assert(footprint.line[1] > footprint.line[0] && footprint.line[3] > 20, 'A pitched camera must show the wrapped route ribbon');
      assert(footprint.photo[0] > 200 && footprint.photo[1] > 170 && footprint.photo[3] > 80, 'Deck must draw later layers normally after the raw density pass');
      assert.equal(footprint.outsideView, 0);
      assert.equal(footprint.hidden[3], 0);
      assert.equal(footprint.ownedHidden, false);
      assert(footprint.ownedRestored && footprint.restored[3] > 20, 'Restoring trajectory visibility must rebuild the density target');
      console.log('Trajectory GPU picking passed:', {count: result.count, zoomFactor, devicePixelRatio: result.dpr});
      window.destroy(); window = null;
    }
  } catch (error) {
    console.error(`GPU acceptance failed at ${stage}${targetDpr === undefined ? '' : ` (target DPR=${targetDpr})`}`);
    console.error(error);
    process.exitCode = 1;
  }
  finally { window?.destroy(); rmSync(directory, {recursive: true, force: true}); app.quit(); }
});
