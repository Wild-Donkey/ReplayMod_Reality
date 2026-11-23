const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const file = path.resolve(__dirname, "../../apps/desktop/src/renderer/features/map/mapScrollInput.ts");
const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const exportsObject = {};
const wheelType = { DOM_DELTA_PIXEL: 0, DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 };

function testMap(identifyWheelFromDeltas, devicePixelRatio) {
  let wheelHandler, setSource, sendGesture;
  const pans = [], zooms = [];
  const replaymod = {
    identifyWheelFromDeltas,
    onScrollSource(listener) { setSource = listener; return () => { setSource = undefined; }; },
    onMapScrollGesture(listener) { sendGesture = listener; return () => { sendGesture = undefined; }; },
  };
  vm.runInNewContext(outputText, { exports: exportsObject, window: { replaymod, devicePixelRatio }, AbortController, WheelEvent: wheelType });
  const canvas = {
    clientWidth: 640, clientHeight: 480,
    getBoundingClientRect: () => ({ left: 20, top: 30 }),
    addEventListener(_name, listener, { signal }) {
      wheelHandler = listener;
      signal.addEventListener("abort", () => { wheelHandler = undefined; });
    },
  };
  const stop = exportsObject.installMapScrollInput({
    getCanvasContainer: () => canvas,
    panBy: ([x, y]) => pans.push([x, y]),
    getZoom: () => 5,
    unproject: ([x, y]) => [x, y],
    easeTo: ({ zoom, around: [x, y] }) => zooms.push([zoom, x, y]),
  });
  return {
    pans, zooms, stop,
    source: value => setSource(value),
    gesture: value => sendGesture(value),
    wheel(deltaX, deltaY, wheelDeltaY, options = {}) {
      let captured = false;
      wheelHandler({ deltaX, deltaY, wheelDeltaY, deltaMode: 0, ctrlKey: false,
        preventDefault() {}, stopImmediatePropagation() { captured = true; }, ...options });
      return captured;
    },
    get active() { return Boolean(wheelHandler || setSource || sendGesture); },
  };
}

const windows = testMap(true, 1.5);
assert.equal(windows.wheel(0, -100, 120), false, "Windows mouse wheel reaches MapLibre at 150% display scaling");
assert.equal(windows.wheel(0, -3, 3), true, "vertical touchpad scroll after mouse zoom still pans");
assert.equal(windows.wheel(-7, -3, 3), true, "touchpad fallback preserves both axes");
assert.equal(windows.wheel(0, -15, 120, { ctrlKey: true }), false, "Chromium pinch reaches MapLibre");
assert.equal(windows.wheel(0, -100, 120), false, "mouse wheel after a touchpad gesture still zooms");
windows.gesture({ dx: 5, dy: 2, zoomDelta: 0, x: 0, y: 0 });
windows.gesture({ dx: 0, dy: 0, zoomDelta: 0.25, x: 120, y: 180 });
assert.deepEqual(windows.pans, [[0, -3], [-7, -3], [5, 2]]);
assert.deepEqual(windows.zooms, [[5.5, 100, 150]]);
windows.stop();
assert.equal(windows.active, false);

const mac = testMap(false, 2);
mac.source("mouse-wheel");
assert.equal(mac.wheel(0, -8, 8), false);
mac.source("trackpad");
assert.equal(mac.wheel(12, 6, 6), true);
assert.deepEqual(mac.pans, [[12, 6]]);
mac.stop();
console.log("Map scroll input passed: alternating mouse wheel, touchpad pan and pinch, native gestures, and cleanup.");
