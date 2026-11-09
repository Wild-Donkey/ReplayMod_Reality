// Independent boundary checks for the unified render engine. These cover the
// React- and GPU-independent pieces (clock, frame scheduling, layer contract,
// binary trajectory buffer, cursor/scene state) by transpiling the TypeScript
// modules into VMs. deck.gl value imports are stubbed; nothing renders here.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const vm = require('node:vm');

const engineDir = path.join('apps', 'desktop', 'src', 'renderer', 'render-engine');
const sharedDir = path.join('apps', 'desktop', 'src', 'renderer', 'shared');
const moduleCache = new Map();
const observers = [];
const decks = [];
class TestView {constructor(props){this.props=props;this.id=props.id;}}
class TestDeck {
  constructor(props){this.props=props;this.isInitialized=true;this.finalized=0;this.draws=[];decks.push(this);}
  setProps(props){this.props={...this.props,...props};}
  redraw(){this.draws.push({views:this.props.views.map(view=>view.id),layers:(this.props.layers??[]).filter(layer=>this.props.layerFilter({layer,viewport:{id:layer.id.split('/')[0]},isPicking:false})).map(layer=>layer.id)});this.props.onAfterRender?.();}
  pickObject(){return null;}
  getCanvas(){return this.canvas??null;}
  getViewports(){return this.viewports??[];}
  finalize(){this.finalized++;this.isInitialized=false;}
}

class TestObserver {
  constructor(callback) {this.callback=callback;this.elements=new Set();observers.push(this);}
  observe(element) {this.elements.add(element);}
  unobserve(element) {this.elements.delete(element);}
  disconnect() {this.elements.clear();}
}

// Deterministic frame queue shared by every module context.
let frameSeq = 1;
const frameQueue = new Map();
const frameHarness = {
  requestAnimationFrame: callback => {
    const id = frameSeq++;
    frameQueue.set(id, callback);
    return id;
  },
  cancelAnimationFrame: id => frameQueue.delete(id),
};
const flushFrames = () => {
  const callbacks = [...frameQueue.values()];
  frameQueue.clear();
  callbacks.forEach(callback => callback());
};

const loadModule = file => {
  file = path.resolve(file);
  if (moduleCache.has(file)) return moduleCache.get(file).exports;
  const moduleObject = {exports: {}};
  moduleCache.set(file, moduleObject);
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const localRequire = specifier => {
    if (specifier === '@deck.gl/core') return {Layer: class {constructor(props){this.props=props;this.id=props.id;}}, WebMercatorViewport: TestView, COORDINATE_SYSTEM:{CARTESIAN:0},Deck:TestDeck,MapView:TestView,OrthographicView:TestView};
    if (specifier === '@deck.gl/layers') {
      class TestLayer { constructor(props) { this.id=props.id; this.props=props; } }
      return {ScatterplotLayer: TestLayer, GeoJsonLayer: TestLayer, LineLayer: TestLayer, SolidPolygonLayer: TestLayer};
    }
    if (specifier === './layers/replayLayers') {
      return {buildTrajectoryLayers: () => []};
    }
    if (specifier.startsWith('.')) {
      return loadModule(path.resolve(path.dirname(file), specifier) + '.ts');
    }
    throw new Error(`Unexpected module import in engine test: ${specifier}`);
  };
  vm.runInNewContext(output, {
    ...frameHarness,
    exports: moduleObject.exports,
    module: moduleObject,
    require: localRequire,
    console,
    setTimeout,
    clearTimeout,
    performance: {now: () => 0},
    ResizeObserver: TestObserver,
    MutationObserver: TestObserver,
    getComputedStyle: element => ({getPropertyValue: () => element.background ?? ""}),
  }, {filename: file});
  return moduleObject.exports;
};

const load = name => loadModule(path.join(engineDir, name) + '.ts');

{
  const {compileAnnotationGeometry, committedAnnotationGeometry, legacyMapAnnotationGeometry} = load('AnnotationGeometry');
  const project={format:'replaymod.annotations',version:1,name:'test',nodes:[
    {id:'hidden',kind:'folder',parentId:null,name:'hidden',visible:false,coordinates:[]},
    {id:'child',kind:'route',parentId:'hidden',name:'child',visible:true,color:'#fff',coordinates:[[1,2],[3,4]]},
    {id:'route',kind:'route',parentId:null,name:'route',visible:true,color:'#123456',coordinates:[[5,6],[7,8]]},
    {id:'place',kind:'point',parentId:null,name:'place',visible:true,color:'#123456',coordinates:[[8,9,100]]},
  ]};
  const compiled=compileAnnotationGeometry(project,'route',[[9,10]]);
  assert.equal(compiled.features.length,3);
  assert.equal(compiled.features[0].id,'route');
  assert.equal(compiled.features[0].properties.selected,true);
  assert.equal(compiled.features[1].geometry.type,'Point');
  const committed=committedAnnotationGeometry(compiled);
  assert.equal(committed.features.length,2);
  assert.equal(committed.features[0],compiled.features[0]);
  assert.equal(compiled.features.length,3);
  assert.equal(committedAnnotationGeometry(committed),committed);
  assert.equal(compiled.features[1].id,'place');assert.equal(compiled.features[1].geometry.coordinates[2],100);
  const legacy=legacyMapAnnotationGeometry(compiled);
  assert.equal(legacy.features.length,2);assert.equal(legacy.features[0].id,'route');assert.equal(legacy.features[1].id,'draft');
  assert.equal(legacyMapAnnotationGeometry(compiled),legacy);
  const {ReplayScene}=load('ReplayScene');
  const scene=new ReplayScene();
  scene.setAnnotationGeometry(compiled);
  scene.setCursor(null);
  assert.equal(scene.current.annotationGeometry,compiled);
  compiled.features[0].geometry.coordinates[0][0]=999;
  assert.equal(project.nodes[2].coordinates[0][0],5);
}

{
  const {applyMapLayerVisibility} = load('MapLayerVisibility');
  const {defaultLayerVisibility} = load('LayerVisibility');
  const ids=['footprint-points-circle','footprint-route-line','photo-points-circle','annotation-routes','elevation-buildings','elevation-glass','provider-label'];
  const values=new Map(ids.map(id=>[id,'visible']));
  let writes=0;
  const map={getStyle:()=>({layers:ids.map(id=>({id}))}),getLayoutProperty:id=>values.get(id),setLayoutProperty:(id,key,value)=>{values.set(id,value);writes++;}};
  applyMapLayerVisibility(map,{...defaultLayerVisibility,annotations:false},{density:true,line:true},'annotations');
  assert.equal(values.get('annotation-routes'),'none');
  assert.equal(values.get('elevation-buildings'),'visible');
  applyMapLayerVisibility(map,defaultLayerVisibility,{density:false,line:true},'trajectory');
  assert.equal(values.get('footprint-points-circle'),'none');
  assert.equal(values.get('footprint-route-line'),'visible');
  const before=writes;
  applyMapLayerVisibility(map,defaultLayerVisibility,{density:false,line:true},'trajectory');
  assert.equal(writes,before);
  applyMapLayerVisibility(map,defaultLayerVisibility,{density:false,line:true,photosInEngine:true},'trajectory');
  assert.equal(values.get('photo-points-circle'),'none');
  applyMapLayerVisibility(map,defaultLayerVisibility,{density:false,line:true},'trajectory');
  assert.equal(values.get('photo-points-circle'),'visible');

  applyMapLayerVisibility(map,{...defaultLayerVisibility,trajectory:false},{density:false,line:true},'trajectory');
  assert.equal(values.get('photo-points-circle'),'none');
  assert.equal(values.get('footprint-route-line'),'none');
  assert.equal(values.get('provider-label'),'visible');
}

{
  const {ReplayScene} = load('ReplayScene');
  const {synchronizedPoint} = load('SynchronizedPoint');
  const {createDeckLayerRegistry} = load('backends/DeckLayerRegistry');
  const scene = new ReplayScene();
  assert.equal(synchronizedPoint(scene.current,scene.clock.current),null);
  scene.setCursor({source:'elevation',timestamp:null,trajectoryIndex:null,coordinate:[116,40]});
  assert.equal(synchronizedPoint(scene.current,scene.clock.current)[0],116);
  const mapLayers=createDeckLayerRegistry().build(scene.current,scene.clock.current);
  assert.equal(mapLayers.length,1);
  assert.equal(mapLayers[0].id,'map/synchronized-point');
  assert.equal(mapLayers[0].props.data[0][0],116);
  scene.setVisibility({...scene.current.visibility,trajectory:false});
  assert.equal(synchronizedPoint(scene.current,scene.clock.current)[0],116);
  scene.setVisibility({...scene.current.visibility,annotations:false});
  assert.equal(synchronizedPoint(scene.current,scene.clock.current),null);
  assert.equal(createDeckLayerRegistry().build(scene.current,scene.clock.current).length,0);
  scene.setCursor({source:'timeline',timestamp:1,trajectoryIndex:0,coordinate:[117,41]});
  assert.equal(synchronizedPoint(scene.current,scene.clock.current),null);
  scene.setVisibility({...scene.current.visibility,trajectory:true});
  assert.equal(synchronizedPoint(scene.current,scene.clock.current)[0],117);
  scene.setCursor({source:'map',timestamp:null,trajectoryIndex:null,coordinate:[NaN,40]});
  assert.equal(synchronizedPoint(scene.current,scene.clock.current),null);
}

{
  const {replayPhotoPoints} = load('PhotoPoints');
  const {createDeckLayerRegistry} = load('backends/DeckLayerRegistry');
  const {ReplayScene} = load('ReplayScene');
  const coordinates = [179.999998, 21, -179.999998, 22];
  const data = replayPhotoPoints(coordinates);
  assert.equal(replayPhotoPoints(coordinates),data);
  assert.deepEqual(Array.from(data.attributes.getPosition.value),coordinates);
  const scene = new ReplayScene();
  scene.setPhotos(data);
  const registry = createDeckLayerRegistry({photos:true});
  const layers = registry.build(scene.current,scene.clock.current);
  assert.equal(layers[0].id,'map/photo-visual');
  assert.equal(layers[0].props.data,data);
  assert.equal(layers[0].props.pickable,false);
  scene.setVisibility({...scene.current.visibility,trajectory:false});
  assert.equal(registry.build(scene.current,scene.clock.current).length,0);
}

// Visibility is shared across backends, and registration/unregistration owns
// exactly one channel lifetime. Hidden groups must not build GPU layers.
{
  const {ReplayScene} = load('ReplayScene');
  const {RenderChannelRegistry} = load('RenderChannelRegistry');
  const {ReplayLayerRegistry} = load('LayerRegistry');
  const scene = new ReplayScene();
  const channels = new RenderChannelRegistry(scene);
  const visibility = [];
  let disposed = 0;
  const release = channels.register({id:'map/test', group:'trajectory', setVisible:value=>visibility.push(value), dispose:()=>disposed++});
  scene.setVisibility({...scene.current.visibility, trajectory:false});
  assert.deepEqual(visibility,[true,false]);
  release(); release(); channels.destroy();
  assert.equal(disposed,1);
  channels.destroy();
  assert.throws(()=>channels.register({id:'late',group:'trajectory',setVisible:()=>{},dispose:()=>{}}),/destruction/);
  const layers = new ReplayLayerRegistry();
  let builds = 0;
  layers.register({id:'hidden',views:['map'],order:0,visibilityGroup:'trajectory',build:()=>{builds++;return [];}});
  layers.build(scene.current,scene.clock.current);
  assert.equal(builds,0);
  scene.setVisibility({...scene.current.visibility,trajectory:true});
  layers.build(scene.current,scene.clock.current);
  assert.equal(builds,1);
  const failed = new RenderChannelRegistry(scene);
  let rollback=0,remaining=0;
  assert.throws(()=>failed.register({id:'bad',group:'roads',setVisible:()=>{throw new Error('setup');},dispose:()=>rollback++}),/setup/);
  assert.equal(rollback,1);
  failed.register({id:'bad',group:'roads',setVisible:()=>{},dispose:()=>{throw new Error('cleanup');}});
  failed.register({id:'remaining',group:'roads',setVisible:()=>{},dispose:()=>remaining++});
  assert.throws(()=>failed.destroy(),/cleanup failed/);
  assert.equal(remaining,1);
  failed.destroy();
}

// Asynchronous style insertion and synchronous styledata events must neither
// lose visibility policy nor recursively refresh the map forever.
{
  const {ReplayScene} = load('ReplayScene');
  const {registerMapStyleChannels} = load('MapRenderChannels');
  const scene = new ReplayScene();
  scene.setVisibility({...scene.current.visibility, annotations:false});
  let style;
  const listeners = new Set();
  const values = new Map();
  let writes = 0;
  const map = {
    getStyle:()=>style,
    getLayoutProperty:id=>values.get(id),
    setLayoutProperty:(id,property,value)=>{ values.set(id,value); writes++; for(const listener of listeners)listener(); },
    on:(event,listener)=>listeners.add(listener),
    off:(event,listener)=>listeners.delete(listener),
  };
  const release = registerMapStyleChannels(scene,map,'test',layer=>layer.id.startsWith('annotation')?'annotations':null);
  style={layers:[{id:'annotation-route'},{id:'provider-label'}]};
  for(const listener of listeners)listener();
  assert.equal(values.get('annotation-route'),'none');
  assert.equal(values.get('provider-label'),undefined);
  assert.equal(writes,1);
  for(const listener of listeners)listener();
  assert.equal(writes,1);
  scene.setVisibility({...scene.current.visibility,annotations:true});
  assert.equal(values.get('annotation-route'),'visible');
  release(); release();
  assert.equal(listeners.size,0);
  scene.setVisibility({...scene.current.visibility,annotations:false});
  assert.equal(values.get('annotation-route'),'visible');
}

{
  const {ReplayScene} = load('ReplayScene');
  const {ReplayPlayback} = load('ReplayPlayback');
  const scene = new ReplayScene();
  const playback = new ReplayPlayback(scene.clock,[1000,2000]);
  playback.step(-1);
  assert.equal(scene.clock.current.time,1000);
  playback.step(1);
  assert(Math.abs(scene.clock.current.time-1033.3333333333333)<1e-8);
  playback.play(); playback.play();
  assert.equal(frameQueue.size,1);
  const tick=[...frameQueue.values()][0];frameQueue.clear();tick(500);
  assert(Math.abs(scene.clock.current.time-1533.3333333333333)<1e-8);
  playback.pause();
  assert.equal(frameQueue.size,0);
  assert.equal(scene.clock.current.mode,'interactive');
  playback.play();
  const end=[...frameQueue.values()][0];frameQueue.clear();end(5000);
  assert.equal(scene.clock.current.time,2000);
  assert.equal(scene.clock.current.mode,'interactive');
  assert.equal(frameQueue.size,0);
  playback.play();
  assert.equal(scene.clock.current.time,1000);
  playback.destroy();
  assert.equal(frameQueue.size,0);
}

// --- ReplayClock ---------------------------------------------------------
{
  const {ViewLayoutController}=load('ViewLayoutController');
  const rect={left:31,top:47,right:131,bottom:147,width:100,height:100};
  let chart={hidden:false,offsetParent:{},getBoundingClientRect:()=>rect};
  const scope={querySelector:selector=>selector==='.timeline-metric-plot'?chart:null};
  const root={parentElement:scope,getBoundingClientRect:()=>rect};
  const layout=new ViewLayoutController(root,()=>{});
  const [resize,mutation]=observers.slice(-2);
  const previous=chart;
  assert(resize.elements.has(previous));
  chart={...chart};mutation.callback();
  assert(!resize.elements.has(previous));
  assert(resize.elements.has(chart));
  layout.destroy();
  assert.equal(resize.elements.size,0);
  assert.equal(mutation.elements.size,0);
  assert.equal(frameQueue.size,0);
  mutation.callback();
  assert.equal(frameQueue.size,0);
}

const {ReplayClock} = load('ReplayClock');
{
  const {ReplayScene}=load('ReplayScene');
  const {ReplayRenderEngine}=load('ReplayRenderEngine');
  const {ReplayLayerRegistry}=load('LayerRegistry');
  const scene=new ReplayScene(),registry=new ReplayLayerRegistry();
  let builds=0,renders=0,disposed=0;
  registry.register({id:'test',views:['map'],order:0,build:()=>{builds++;return [{id:'map/test'}];}});
  const backend={setViews:()=>{},render:()=>{renders++;},pick:query=>{assert.equal(query.x,10);assert.equal(query.y,20);return null;},destroy:()=>{disposed++;}};
  const rect={left:31,top:47,right:131,bottom:147,width:100,height:100};
  const root={parentElement:{querySelector:()=>null},getBoundingClientRect:()=>rect};
  const engine=new ReplayRenderEngine(root,scene,backend,registry);
  flushFrames();
  assert.equal(builds,1);
  assert.equal(scene.picking.pick({viewId:'map',x:41,y:67}),null);
  const before=renders;
  scene.setMapViewState({longitude:1,latitude:2,zoom:3,bearing:0,pitch:0});
  assert.equal(renders,before+1,'Camera renders synchronously');
  assert.equal(builds,1,'Camera motion reuses geometry');
  scene.setVisibility({...scene.current.visibility,roads:false});flushFrames();
  assert.equal(builds,2);
  engine.destroy();engine.destroy();
  assert.equal(disposed,1);
  assert.equal(scene.picking.pick({viewId:'map',x:41,y:67}),undefined);
  const after=renders;
  scene.clock.setTime(100);flushFrames();
  assert.equal(renders,after);
  assert.equal(frameQueue.size,0);
}
const clock = new ReplayClock();
let clockEvents = 0;
assert.equal(clock.current.time, null);
assert.equal(clock.current.frame, 0);
assert.equal(clock.current.mode, 'interactive');
clock.subscribe(() => { clockEvents += 1; }); // subscriber receives current state once
assert.equal(clockEvents, 1);
clock.setTime(100);
assert.equal(clock.current.time, 100);
assert.equal(clock.current.frame, 1);
assert.equal(clockEvents, 2);
clock.setTime(100); // identical time/mode must not emit
assert.equal(clock.current.frame, 1);
assert.equal(clockEvents, 2);
clock.setTime(100, 'playback'); // mode change emits even at same time
assert.equal(clock.current.mode, 'playback');
assert.equal(clockEvents, 3);
clock.step(50, 7); // export stepping uses an explicit deterministic frame
assert.equal(clock.current.time, 50);
assert.equal(clock.current.frame, 7);
assert.equal(clock.current.mode, 'export');

// --- RenderScheduler -----------------------------------------------------
frameSeq = 1;
const {RenderScheduler} = load('RenderScheduler');
let frameRenders = 0;
let frameReasons = null;
const scheduler = new RenderScheduler(reasons => {
  frameRenders += 1;
  frameReasons = reasons;
});
scheduler.invalidate('scene');
scheduler.invalidate('clock');
scheduler.invalidate('scene'); // repeated invalidations coalesce into one frame
flushFrames();
assert.equal(frameRenders, 1);
assert.deepEqual([...frameReasons].sort(), ['clock', 'scene']);
scheduler.invalidate('layout');
scheduler.destroy(); // pending frame is cancelled on teardown
flushFrames();
assert.equal(frameRenders, 1);

// flushSync renders immediately and cancels the queued animation frame, so
// camera updates land in the same frame instead of lagging one frame behind.
frameSeq = 100;
let syncRenders = 0;
const syncScheduler = new RenderScheduler(() => { syncRenders += 1; });
syncScheduler.invalidate('scene');
syncScheduler.flushSync();
assert.equal(syncRenders, 1);
flushFrames();
assert.equal(syncRenders, 1); // no second render from the cancelled frame
syncScheduler.flushSync(); // nothing pending is a no-op
assert.equal(syncRenders, 1);
syncScheduler.destroy();

// --- Layer registry contract --------------------------------------------
const {ReplayLayerRegistry} = load('LayerRegistry');
const registry = new ReplayLayerRegistry();
const layerDefinition = {id: 'dup', views: ['map'], order: 1, build: () => []};
registry.register(layerDefinition);
assert.throws(() => registry.register(layerDefinition), /already registered/);
assert.throws(
  () => registry.register({id: 'no-views', views: [], order: 0, build: () => []}),
  /at least one view/,
);
registry.register({id: 'late', views: ['map'], order: 200, build: () => [{id: 'map/late'}]});
registry.register({
  id: 'early',
  views: ['timeline'],
  order: 100,
  build: () => [{id: 'timeline/early-a'}, {id: 'timeline/early-b'}],
});
// A layer that renders into a view its definition does not declare is rejected.
const escapingRegistry = new ReplayLayerRegistry();
escapingRegistry.register({
  id: 'escaping',
  views: ['map'],
  order: 50,
  build: () => [{id: 'timeline/escaping'}],
});
assert.throws(() => escapingRegistry.build({}, clock.current), /undeclared view/);
const built = registry.build({}, clock.current);
const builtIds = []; // materialize from the VM realm into this realm before comparing
for (const layer of built) builtIds.push(layer.id);
assert.deepEqual(builtIds, [
  'timeline/early-a', // order 100 before 200, ties broken by id
  'timeline/early-b',
  'map/late',
]);

// --- TrajectoryBuffer ----------------------------------------------------
const bufferPath = path.join(engineDir, 'buffers', 'TrajectoryBuffer.ts');
const {TrajectoryBuffer} = loadModule(bufferPath);
// Move east along the equator: 0.01 degree longitude is ~1111.95 m, bearing 90.
const dataset = {
  timelineTimestamps: [0, 1000, 2000],
  timelineAltitudes: [0, 10, 20],
  timelineCoordinates: [0, 0, 0.01, 0, 0.02, 0],
};
const buffer = TrajectoryBuffer.fromPointDataset(dataset);
assert.equal(TrajectoryBuffer.fromPointDataset(dataset),buffer,'All carriers share one compiled buffer per dataset');
assert.equal(buffer.length, 3);
assert.deepEqual([...buffer.positions], [0, 0, 0.01, 0, 0.02, 0]);
assert.deepEqual([...buffer.altitudes], [0, 10, 20]);
assert.ok(Math.abs(buffer.distances[1] - 1111.95) < 0.01);
assert.ok(Math.abs(buffer.distances[2] - 2223.9) < 0.02);
assert.deepEqual([...buffer.headings], [90, 90, 90]);
const beforeMidpoint = buffer.sample(250);
assert.equal(beforeMidpoint.index, 0);
assert.ok(Math.abs(beforeMidpoint.position[0] - 0.0025) < 1e-12);
const midpoint = buffer.sample(500); // exact tie resolves to the right sample
assert.equal(midpoint.index, 1);
assert.ok(Math.abs(midpoint.position[0] - 0.005) < 1e-12);
const afterMidpoint = buffer.sample(750);
assert.equal(afterMidpoint.index, 1);
assert.ok(Math.abs(afterMidpoint.position[0] - 0.0075) < 1e-12);
assert.equal(buffer.sample(null), null);
assert.equal(buffer.sample(NaN), null);
assert.equal(buffer.sample(Infinity), null);
const datelineBuffer = TrajectoryBuffer.fromPointDataset({
  timelineTimestamps:[0,1000],timelineAltitudes:[0,0],timelineCoordinates:[179,10,-179,10],
});
assert.equal(Math.abs(datelineBuffer.sample(500).position[0]),180);
assert.equal(datelineBuffer.sample(250).position[0],179.5);
const empty = TrajectoryBuffer.fromPointDataset({
  timelineTimestamps: [], timelineAltitudes: [], timelineCoordinates: [],
});
assert.equal(empty.length, 0);
assert.equal(empty.sample(1000), null);
// Northward movement gives bearing 0 (guards the shared bearing helper wiring).
const north = TrajectoryBuffer.fromPointDataset({
  timelineTimestamps: [0, 1000],
  timelineAltitudes: [0, 0],
  timelineCoordinates: [10, 20, 10, 20.01],
});
assert.ok(Math.abs(north.headings[0]) < 1e-9);

// --- Cursor equality -----------------------------------------------------
const {sameReplayCursor} = load('ReplayCursor');
assert.equal(sameReplayCursor(null, null), true);
assert.equal(sameReplayCursor(null, {source: 'map', timestamp: 1, trajectoryIndex: null, coordinate: null}), false);
const cursor = {source: 'timeline', timestamp: 100, trajectoryIndex: 2, coordinate: [1, 2]};
assert.equal(sameReplayCursor(cursor, {...cursor, coordinate: [1, 2]}), true);
assert.equal(sameReplayCursor(cursor, {...cursor, source: 'map'}), false);

// --- ReplayScene ---------------------------------------------------------
const {ReplayScene} = load('ReplayScene');
const scene = new ReplayScene();
let sceneRevisions = 0;
scene.subscribe(() => { sceneRevisions += 1; });
const initialRevision = scene.current.revision;
scene.setMapViewState({longitude: 1, latitude: 2, zoom: 3, bearing: 0, pitch: 0});
assert.equal(scene.current.mapViewState.longitude, 1);
assert.equal(scene.current.revision, initialRevision + 1);
assert.equal(sceneRevisions, 2); // subscribe replay plus one change notification
scene.setTrajectory(buffer);
assert.equal(scene.current.trajectory, buffer);
scene.setCursorTime('timeline', 500);
assert.equal(scene.current.cursor.trajectoryIndex, 1);
assert.ok(Math.abs(scene.current.cursor.coordinate[0] - 0.005) < 1e-12);
const cursorRevision = scene.current.revision;
scene.setCursor({...scene.current.cursor}); // identical content does not bump revision
assert.equal(scene.current.revision, cursorRevision);
scene.setCursorTime('timeline', null);
assert.equal(scene.current.cursor, null);
// Replacing the trajectory re-resolves an active cursor against the new buffer.
scene.setCursorTime('timeline', 250);
assert.equal(scene.current.cursor.trajectoryIndex, 0);
scene.setTrajectory(TrajectoryBuffer.fromPointDataset(dataset));
assert.equal(scene.current.cursor.trajectoryIndex, 0);
assert.ok(Math.abs(scene.current.cursor.coordinate[0] - 0.0025) < 1e-12);

// --- Production trajectory picking boundaries ----------------------------
{
  const {ReplayPicking} = load('ReplayPicking');
  const bridge = new ReplayPicking(), query = {viewId:'map',x:31,y:47,radius:12};
  assert.equal(bridge.pick(query),undefined);
  const first = bridge.attach(() => null);
  const result = {objectId:'trajectory/0'};
  const second = bridge.attach(() => result);
  first();
  assert.equal(bridge.pick(query),result,'Stale renderer cleanup cannot detach its replacement');
  assert.equal(bridge.pick({...query,x:NaN}),null);
  assert.equal(bridge.pick({...query,radius:-1}),null);
  second();second();
  assert.equal(bridge.pick(query),undefined);
  const samePicker=()=>result;
  const releaseA=bridge.attach(samePicker), releaseB=bridge.attach(samePicker);
  releaseA();assert.equal(bridge.pick(query),result);
  releaseB();assert.equal(bridge.pick(query),undefined);
}
{
  const {PickingController} = load('PickingController');
  const {createDeckLayerRegistry} = load('backends/DeckLayerRegistry');
  const scene = new ReplayScene();scene.setTrajectory(buffer);
  const registry = createDeckLayerRegistry();
  const layer = registry.build(scene.current,scene.clock.current)[0];
  assert.equal(layer.id,'map/trajectory-picking');
  assert.equal(layer.props.data.attributes.getPosition.value,buffer.positions);
  assert.equal(layer.props.data.length,buffer.length);
  scene.setCursorTime('timeline',250);
  assert.equal(registry.build(scene.current,scene.clock.current)[0].props.data,layer.props.data,'Cursor changes reuse binary attributes');
  let calls=0, lastQuery;
  let info = {picked:true,viewport:{id:'map'},index:1,layer};
  const deck = {isInitialized:false,pickObject:query=>{calls++;lastQuery=query;return info;}};
  const picker = new PickingController(deck,()=>scene.current);
  const query = {viewId:'map',target:'trajectory',x:100,y:120,radius:12};
  assert.equal(picker.pick(query),null);assert.equal(calls,0);
  deck.isInitialized=true;
  const hit = picker.pick(query);
  assert.equal(hit.objectId,'trajectory/1');assert.equal(hit.trajectoryIndex,1);
  assert.equal(hit.timestamp,buffer.timestamps[1]);assert.equal(hit.distance,buffer.distances[1]);
  assert.deepEqual(Array.from(hit.coordinate),Array.from(buffer.positions.slice(2,4)));
  assert.equal(lastQuery.layerIds[0],'map/trajectory-picking');assert.equal(lastQuery.radius,12);
  assert.equal(picker.pick({...query,viewId:'timeline'}),null);
  scene.setVisibility({...scene.current.visibility,trajectory:false});
  const before=calls;assert.equal(picker.pick(query),null);assert.equal(calls,before);
  assert.equal(registry.build(scene.current,scene.clock.current).length,0);
  scene.setVisibility({...scene.current.visibility,trajectory:true});
  info={...info,index:buffer.length};assert.equal(picker.pick(query),null);
  info={...info,index:0.5};assert.equal(picker.pick(query),null);
  info={...info,index:0,viewport:{id:'elevation'}};assert.equal(picker.pick(query),null);
  info={...info,viewport:{id:'map'}};
  scene.setTrajectory(north);assert.equal(picker.pick(query),null,'Stale GPU hits cannot decode against a new dataset');
  scene.setTrajectory(null);assert.equal(picker.pick(query),null);
}

// Annotation picking shares geometry identity, visibility and client-space queries.
{
  const {PickingController}=load('PickingController');
  const {annotationPickingGeometry}=load('AnnotationGeometry');
  const {createDeckLayerRegistry}=load('backends/DeckLayerRegistry');
  const scene=new ReplayScene();
  const geometry={type:'FeatureCollection',features:[
    {type:'Feature',id:'route',properties:{id:'route',selected:true},geometry:{type:'LineString',coordinates:[[1,2,900],[3,4,1000]]}},
    {type:'Feature',id:'place',properties:{id:'place'},geometry:{type:'Point',coordinates:[1,2,900]}},
    {type:'Feature',id:'draft',properties:{id:'draft'},geometry:{type:'Point',coordinates:[5,6]}},
  ]};
  scene.setAnnotationGeometry(geometry);
  const data=annotationPickingGeometry(geometry);
  assert.equal(data,annotationPickingGeometry(geometry));
  assert.equal(data.features.length,2,'Drafts never occlude committed annotations during picking');
  assert.deepEqual(Array.from(data.features[0].geometry.coordinates[0]),[1,2],'Picking uses the same map plane as existing routes');
  assert.equal(geometry.features[0].geometry.coordinates[0][2],900,'Survey elevations remain intact');
  const layer=createDeckLayerRegistry().build(scene.current,scene.clock.current)[0];
  assert.equal(layer.id,'map/annotation-picking');assert.equal(layer.props.data,data);
  scene.setCursor({source:'annotation',timestamp:null,trajectoryIndex:null,coordinate:[1,2]});
  assert.equal(createDeckLayerRegistry().build(scene.current,scene.clock.current)[0].props.data,data);
  let info={picked:true,viewport:{id:'map'},index:0,layer:{id:'map/annotation-picking-linestrings'},object:data.features[0],coordinate:[2,3]};
  let calls=0, options;
  const picker=new PickingController({isInitialized:true,pickObject:query=>{calls++;options=query;return info;}},()=>scene.current);
  const query={viewId:'map',target:'annotation',x:100,y:120,radius:5};
  let hit=picker.pick(query);
  assert.equal(hit.kind,'annotation');assert.equal(hit.annotationId,'route');assert.equal(hit.objectId,'annotation/route');
  assert.equal(hit.timestamp,null);assert.equal(hit.trajectoryIndex,null);assert.equal(hit.distance,null);
  assert.equal(options.layerIds.length,1);assert.equal(options.layerIds[0],'map/annotation-picking');
  assert.equal(options.radius,5);
  info={...info,index:1,object:data.features[1]};assert.equal(picker.pick(query).annotationId,'place');
  scene.setVisibility({...scene.current.visibility,trajectory:false});
  assert.equal(picker.pick(query).annotationId,'place','Annotations do not depend on trajectory visibility');
  scene.setVisibility({...scene.current.visibility,annotations:false});
  const before=calls;assert.equal(picker.pick(query),null);assert.equal(calls,before);
  scene.setVisibility({...scene.current.visibility,annotations:true});
  scene.setAnnotationGeometry({...geometry,features:geometry.features.map(feature=>({...feature}))});
  assert.equal(picker.pick(query),null,'An edited annotation cannot decode a stale GPU hit');
  const replacement=annotationPickingGeometry(scene.current.annotationGeometry);
  info={...info,object:replacement.features[1]};assert.equal(picker.pick(query).annotationId,'place');
  scene.setAnnotationGeometry({type:'FeatureCollection',features:[geometry.features[2]]});
  assert.equal(createDeckLayerRegistry().build(scene.current,scene.clock.current).filter(layer=>layer.id==='map/annotation-picking').length,0);
  assert.equal(picker.pick(query),null);
}

// Shared metric geometry preserves units, gaps and precision independently of GPU.
{
  const {metricSegments,metricXAt}=load('MetricSeries');
  const epoch=1_800_000_000_000;
  const series={id:'speed',space:'timeline',x:new Float64Array([epoch,epoch+1,epoch+2,epoch+3,epoch+4]),values:new Float64Array([0,1,NaN,2,3]),xDomain:[epoch,epoch+4],yDomain:[0,4]};
  const data=metricSegments(series);
  assert.equal(data.length,2);assert.deepEqual(Array.from(data.sampleIndices),[0,3],'Missing samples break the curve');
  assert.equal(data.positions[0],0);assert.equal(data.positions[3],0.25,'1 ms survives modern epoch normalization');
  assert.equal(data.positions[1],1);assert.equal(data.positions[4],0.75);
  assert.equal(data.attributes.getSourcePosition.value,data.positions);assert.equal(data.attributes.getTargetPosition.value,data.positions);
  assert.equal(data.attributes.getTargetPosition.offset,12);assert.equal(data.attributes.getSourcePosition.stride,24);
  assert.equal(metricSegments(series),data,'Unchanged content reuses segment buffers');
  assert.equal(metricXAt(series,0.25),epoch+1);
  const clipped=metricSegments({...series,x:new Float64Array([-10,10]),values:new Float64Array([0,20]),xDomain:[0,5],yDomain:[0,20]});
  assert.equal(clipped.positions[0],0);assert.equal(clipped.positions[3],1);
  assert.equal(clipped.positions[1],0.5);assert.equal(clipped.positions[4],0.25);
  const vertical=metricSegments({...series,x:new Float64Array([1,1]),values:new Float64Array([0,1]),xDomain:[0,2],yDomain:[0,1]});
  assert.equal(vertical.positions[1],1);assert.equal(vertical.positions[4],0,'Same-X samples retain vertical segments');
  assert.equal(metricSegments({...series,xDomain:[1,1]}).length,0);
  assert.equal(metricSegments({...series,yDomain:[0,0]}).length,0);
  assert.equal(metricSegments({...series,x:new Float64Array([2,1]),values:new Float64Array([0,1]),xDomain:[0,3]}).length,0);
  assert.equal(metricXAt({...series,padding:{left:0.1,right:0.2,top:0,bottom:0}},0.1),epoch);
}
{
  const {PickingController}=load('PickingController');
  const {metricSegments}=load('MetricSeries');
  const {createDeckLayerRegistry}=load('backends/DeckLayerRegistry');
  const scene=new ReplayScene();scene.setTrajectory(buffer);
  const series={id:'speed',space:'timeline',sourceTrajectory:buffer,x:new Float64Array([0,1000]),values:new Float64Array([0,10]),xDomain:[0,1000],yDomain:[0,10]};
  const release=scene.registerMetricSeries('timeline',series);
  const data=metricSegments(series);
  const layer=createDeckLayerRegistry().build(scene.current,scene.clock.current).find(layer=>layer.id==='timeline/metric-picking/speed');
  assert.equal(layer.props.data,data);
  let info={picked:true,viewport:{id:'timeline'},index:0,layer,coordinate:[0.25,0.75]};
  let calls=0;
  const picker=new PickingController({isInitialized:true,pickObject:()=>{calls++;return info;}},()=>scene.current);
  let query={viewId:'timeline',target:'metric',x:100,y:100,radius:5};
  const hit=picker.pick(query);
  assert.equal(hit.kind,'metric');assert.equal(hit.seriesId,'speed');assert.equal(hit.timestamp,250);assert.equal(hit.sampleIndex,0);
  assert.equal(hit.trajectoryIndex,0);assert(Math.abs(hit.coordinate[0]-0.0025)<1e-10);
  const flightBuffer=TrajectoryBuffer.fromPointDatasetWithFlightRoutes(dataset,[{startTime:0,endTime:1000,path:[[10,20],[11,20]]}]);
  scene.setTrajectory(flightBuffer);
  assert.equal(flightBuffer.timestamps,buffer.timestamps,'Flight geometry shares the original time axis');
  assert.equal(picker.pick(query)?.timestamp,250,'The original chart still picks against flight geometry');
  assert(picker.pick(query)?.coordinate[0]>10,'Picked coordinates follow the current flight geometry');
  scene.setTrajectory(north);assert.equal(picker.pick(query),null,'Timeline curves cannot decode against a replacement dataset');
  scene.setTrajectory(buffer);
  scene.setVisibility({...scene.current.visibility,trajectory:false});
  const before=calls;assert.equal(picker.pick(query),null);assert.equal(calls,before);
  scene.setVisibility({...scene.current.visibility,trajectory:true});
  const replacement={...series};const releaseReplacement=scene.registerMetricSeries('timeline',replacement);
  release();assert.equal(scene.current.metricSeries.timeline,replacement,'Old component cleanup cannot remove its replacement');
  assert.equal(picker.pick(query),null,'Old metric buffers cannot decode new content');
  releaseReplacement();releaseReplacement();assert.equal(scene.current.metricSeries.timeline,undefined);
  const firstOwner=scene.registerMetricSeries('timeline',series), secondOwner=scene.registerMetricSeries('timeline',series);
  firstOwner();assert.equal(scene.current.metricSeries.timeline,series);
  secondOwner();assert.equal(scene.current.metricSeries.timeline,undefined);
  assert.throws(()=>scene.registerMetricSeries('elevation',series),/space/);
  const elevation={id:'profile',space:'distanceProfile',x:new Float64Array([0,1000]),values:new Float64Array([0,100]),coordinates:new Float64Array([10,20,11,21]),xDomain:[0,1000],yDomain:[0,100]};
  const dispose=scene.registerMetricSeries('elevation',elevation);
  const elevationLayer=createDeckLayerRegistry().build(scene.current,scene.clock.current).find(layer=>layer.id==='elevation/metric-picking/profile');
  info={...info,viewport:{id:'elevation'},layer:elevationLayer,coordinate:[0.8,0.2]};
  query={...query,viewId:'elevation'};
  const picked=picker.pick(query);
  assert.equal(picked.timestamp,null);assert.equal(picked.trajectoryIndex,null);assert.equal(picked.distance,1000);assert.equal(picked.sampleIndex,1);
  assert.deepEqual(Array.from(picked.coordinate),[11,21]);
  scene.setVisibility({...scene.current.visibility,annotations:false});assert.equal(picker.pick(query),null);
  dispose();assert.equal(scene.current.metricSeries.elevation,undefined);
}
{
  const {elevationProfileData,routeLengthKm}=loadModule(path.join('apps','desktop','src','renderer','features','annotations','ElevationProfileData.ts'));
  const coordinates=[[179.9,0,10],[-179.9,0,20],[-179.8,0,NaN],[-179.7,0,30]];
  const data=elevationProfileData(coordinates);
  assert.equal(elevationProfileData(coordinates),data);
  assert(data.totalKm>40&&data.totalKm<50,'Dateline crossing follows the short geographic arc');
  assert.equal(data.minimum,10);assert.equal(data.maximum,30);
  assert.equal(data.series.xDomain[1],data.totalKm*1000);
  assert.equal(data.series.coordinates[2],-179.9);assert(Number.isNaN(data.series.values[2]));
  assert(Math.abs(routeLengthKm(coordinates)-data.totalKm)<1e-10);
  assert.equal(elevationProfileData([[1,2,5],[1,2,6]]),null,'Zero-length profiles cannot form a distance axis');
  assert.equal(elevationProfileData([[1,2,5],[2,3,5]]),null);
  assert.equal(elevationProfileData([[1,2,NaN],[2,3,NaN]]),null);
  assert.equal(elevationProfileData([[1,2,5],[NaN,3,6]]),null);
  const large=Array.from({length:180000},(_,index)=>[(index%1000)/100000,30+Math.floor(index/1000)/100000,index%100]);
  const largeProfile=elevationProfileData(large);
  assert.equal(largeProfile.series.x.length,180000);assert(Number.isFinite(largeProfile.series.xDomain[1]));
  assert.equal(elevationProfileData(large),largeProfile,'Large profiles are compiled once without spreading all elevations onto the call stack');
}

// Visible layers use the same scene geometry and preserve style/area semantics.
{
  const {metricArea,metricSegments}=load('MetricSeries');
  const {createDeckLayerRegistry}=load('backends/DeckLayerRegistry');
  const {annotationColor}=load('layers/AnnotationLayer');
  const {annotationVisualGeometry,annotationPickingGeometry}=load('AnnotationGeometry');
  assert.deepEqual(Array.from(annotationColor('#abc')),[170,187,204,255]);
  assert.deepEqual(Array.from(annotationColor('#12345680')),[18,52,86,128]);
  assert.deepEqual(Array.from(annotationColor('invalid')),[85,207,255,255]);
  const scene=new ReplayScene();
  const geometry={type:'FeatureCollection',features:[{type:'Feature',id:'draft',properties:{id:'draft',color:'#ffe36e',selected:false},geometry:{type:'Point',coordinates:[1,2,100]}}]};
  scene.setAnnotationGeometry(geometry);
  assert.equal(annotationPickingGeometry(geometry).features.length,0);
  assert.equal(annotationVisualGeometry(geometry).features.length,1,'Visible editing drafts remain distinct from pickable committed content');
  const registry=createDeckLayerRegistry({annotations:true,metrics:true});
  const visual=registry.build(scene.current,scene.clock.current).find(layer=>layer.id==='map/annotation-visual');
  assert.equal(visual.props.data,annotationVisualGeometry(geometry));
  assert.equal(visual.props.getLineWidth(visual.props.data.features[0]),0.75);
  assert.deepEqual(Array.from(visual.props.getFillColor(visual.props.data.features[0])),[255,227,110,255]);
  const series={id:'area',space:'timeline',x:new Float64Array([0,1]),values:new Float64Array([-1,1]),xDomain:[0,1],yDomain:[-1,1],color:[201,154,255,255],areaOpacity:0.1};
  scene.registerMetricSeries('timeline',series);
  const area=metricArea(series);
  assert.equal(area.length,2,'Crossing zero splits the area at the true intersection');
  assert.equal(area.attributes.getPolygon.value.length,18);assert.equal(area.startIndices.at(-1),6);
  const triangles=area.attributes.getPolygon.value;
  assert.equal(triangles[3],0.5);assert.equal(triangles[4],0.5);
  assert.equal(metricArea(series),area);
  const layers=registry.build(scene.current,scene.clock.current);
  scene.setTrajectory(buffer);
  const captureLayers=createDeckLayerRegistry({annotations:true,metrics:true,picking:false}).build(scene.current,scene.clock.current);
  assert(!captureLayers.some(layer=>layer.id.includes('picking')),'Offline rendering must not allocate invisible picking layers');
  assert(captureLayers.some(layer=>layer.id==='map/annotation-visual'));
  assert(captureLayers.some(layer=>layer.id==='timeline/metric-line/area'));
  const line=layers.find(layer=>layer.id==='timeline/metric-line/area'), fill=layers.find(layer=>layer.id==='timeline/metric-area/area');
  assert.equal(line.props.data,metricSegments(series));assert.equal(fill.props.data,area);
  assert.deepEqual(Array.from(line.props.getColor),[201,154,255,255]);assert.equal(fill.props.getFillColor[3],26);
  scene.setVisibility({...scene.current.visibility,trajectory:false,annotations:false});
  assert.deepEqual(Array.from(registry.build(scene.current,scene.clock.current), layer => layer.id),
    ['timeline/metric-area/area', 'timeline/metric-line/area'], 'Map visibility switches do not hide the timeline chart');
}
{
  const {createExportScene}=load('export/ReplaySceneExport');
  const source=new ReplayScene();source.setTrajectory(buffer);source.clock.setTime(250,'playback');
  source.setCursorTime('timeline',250);
  source.setAnnotationGeometry({type:'FeatureCollection',features:[{type:'Feature',id:'route',properties:{},geometry:{type:'LineString',coordinates:[[0,0],[1,1]]}},{type:'Feature',id:'draft',properties:{},geometry:{type:'Point',coordinates:[0,0]}}]});
  const exported=createExportScene(source);
  assert.equal(exported.current.trajectory,buffer);assert.equal(exported.current.annotationGeometry.features.length,1);
  assert.equal(exported.current.annotationGeometry.features[0],source.current.annotationGeometry.features[0]);
  assert.equal(exported.current.cursor,null);exported.clock.step(900,99);
  exported.setMapViewState({longitude:99,latitude:10,zoom:3,bearing:0,pitch:0});
  source.setVisibility({...source.current.visibility,annotations:false});
  assert.equal(exported.current.visibility.annotations,true,'Export uses a frozen visibility snapshot');
  assert.equal(source.clock.current.time,250);assert.equal(source.clock.current.mode,'playback');
  assert.equal(source.current.mapViewState.longitude,0);
}

// GPU handoff must paint the opaque background before hiding its DOM fallback.
{
  const {parseReplayColor}=load('ReplayColor');
  assert.deepEqual(Array.from(parseReplayColor('#0d1218')),[13,18,24,255]);
  const translucent=parseReplayColor('rgb(18 18 18 / 66%)');assert.deepEqual(Array.from(translucent.slice(0,3)),[18,18,18]);assert(Math.abs(translucent[3]-168.3)<1e-10);
  assert.deepEqual(Array.from(parseReplayColor('rgba(1, 2, 3, 0.5)')),[1,2,3,127.5]);
  assert.equal(parseReplayColor('transparent'),null);
  const scene=new ReplayScene(), ownership=[];
  let notifications=0;const before=scene.current.revision,stop=scene.visuals.subscribe(()=>notifications++);
  scene.visuals.set({timeline:false,elevation:true});scene.visuals.set({timeline:false,elevation:true});
  assert.equal(notifications,1);assert.equal(scene.current.revision,before,'Visual ownership does not rebuild scene geometry');stop();
  const {DeckRenderBackend}=load('backends/DeckRenderBackend');
  const {createDeckLayerRegistry}=load('backends/DeckLayerRegistry');
  const series={id:'profile',space:'distanceProfile',x:new Float64Array([0,1000]),values:new Float64Array([0,100]),xDomain:[0,1000],yDomain:[0,100]};
  scene.registerMetricSeries('elevation',series);
  const backend=new DeckRenderBackend({},scene.current,{onVisualOwnership:state=>ownership.push(state.elevation)});
  const views=[{id:'map',kind:'map',x:0,y:0,width:800,height:600},{id:'elevation',kind:'orthographic',x:10,y:450,width:700,height:120,backdrop:{x:0,y:420,width:800,height:180,color:[13,18,24,255]}}];
  backend.setViews(views);
  const registry=createDeckLayerRegistry({metrics:['elevation']});
  let layers=registry.build(scene.current,scene.clock.current);backend.render(scene.current,layers);
  const deck=decks.at(-1);
  assert(!deck.props.views.some(view=>view.id==='elevation-backdrop'));
  assert(!deck.draws.at(-1).layers.some(id=>id.startsWith('elevation/metric-line/')),'Uninitialized visual layers do not cover the verified renderer');
  layers.forEach(layer=>{layer.isLoaded=true;});deck.redraw();
  assert.equal(ownership.at(-1),true);
  assert.deepEqual(Array.from(deck.draws.at(-1).views),['map','elevation-backdrop','elevation']);
  assert(deck.draws.at(-1).layers.includes('elevation/metric-line/profile'));
  assert.deepEqual(Array.from(deck.props.views.find(view=>view.id==='elevation-backdrop').props.clearColor),[13,18,24,255]);
  scene.setCursor({source:'elevation',timestamp:null,trajectoryIndex:null,coordinate:[1,2]});
  layers=registry.build(scene.current,scene.clock.current);backend.render(scene.current,layers);
  assert.equal(ownership.at(-1),true,'Cursor-only rebuilds must not flicker back to SVG');
  scene.registerMetricSeries('elevation',{...series});layers=registry.build(scene.current,scene.clock.current);backend.render(scene.current,layers);
  assert.equal(ownership.at(-1),false,'A new profile keeps its fallback until its own buffers are initialized');
  layers.forEach(layer=>{layer.isLoaded=true;});deck.redraw();assert.equal(ownership.at(-1),true);
  const canvas=new EventTarget();deck.canvas=canvas;deck.props.onLoad();
  const savedConsole=console.error;console.error=()=>{};
  try {canvas.dispatchEvent(new Event('webglcontextlost'));}finally{console.error=savedConsole;}
  assert.equal(ownership.at(-1),false);assert(!deck.props.views.some(view=>view.id==='elevation-backdrop'));
  assert.equal(backend.pick({viewId:'elevation',x:10,y:460}),null);
  backend.destroy();backend.destroy();assert.equal(deck.finalized,1);
}

// A float pass owns the footprint only after its first successful draw.
{
  const {DeckRenderBackend}=load('backends/DeckRenderBackend'),{createDeckLayerRegistry}=load('backends/DeckLayerRegistry');
  const scene=new ReplayScene(), states=[];
  scene.setFootprint({mode:'points',coordinates:[0,0],paths:[]});
  const backend=new DeckRenderBackend({},scene.current,{onVisualOwnership:state=>states.push(Boolean(state.footprint))});
  backend.setViews([{id:'map',kind:'map',x:0,y:0,width:800,height:600}]);
  const registry=createDeckLayerRegistry({footprint:true,picking:false});
  const layers=registry.build(scene.current,scene.clock.current);
  const deck=decks.at(-1),layer=layers[0];
  layer.initializeState.call(Object.assign(layer,{state:{}}));
  backend.render(scene.current,layers);
  assert.equal(states.length,0,'The MapLibre fallback retains ownership until a successful draw');
  assert.equal(deck.props.layerFilter({layer,viewport:{id:'map'},isPicking:true}),false);
  layer.state.ready=true;deck.redraw();
  assert.equal(states.at(-1),true);
  layer.state.ready=false;deck.redraw();
  assert.equal(states.at(-1),false,'The float pass can fall back without disabling other Deck layers');
  backend.destroy();
}

// Annotation handoff preserves place-label markers and restores fallback on loss.
{
  const {DeckRenderBackend}=load('backends/DeckRenderBackend'),{createDeckLayerRegistry}=load('backends/DeckLayerRegistry');
  const scene=new ReplayScene(),states=[];
  const geometry={type:'FeatureCollection',features:[
    {type:'Feature',id:'route',properties:{color:'#55cfff',selected:true},geometry:{type:'LineString',coordinates:[[0,0,100],[1,1,100]]}},
    {type:'Feature',id:'place',properties:{name:'place'},geometry:{type:'Point',coordinates:[0,0]}},
    {type:'Feature',id:'draft',properties:{color:'#ffe36e'},geometry:{type:'Point',coordinates:[1,1]}},
  ]};
  scene.setAnnotationGeometry(geometry);
  const backend=new DeckRenderBackend({},scene.current,{onVisualOwnership:state=>states.push(!!state.annotations),devicePixels:1});
  backend.setViews([{id:'map',kind:'map',x:0,y:0,width:800,height:600}]);
  const registry=createDeckLayerRegistry({annotations:true,annotationPoints:false});
  let layers=registry.build(scene.current,scene.clock.current);backend.render(scene.current,layers);
  const deck=decks.at(-1),visual=layers.find(layer=>layer.id==='map/annotation-visual');
  assert.equal(deck.props.useDevicePixels,1,'Explicit export resolution overrides monitor density');
  assert.deepEqual(Array.from(visual.props.data.features,feature=>feature.id),['route','draft']);
  assert.equal(visual.props.lineCapRounded,true);assert.equal(visual.props.lineJointRounded,true);
  assert(!deck.draws.at(-1).layers.includes('map/annotation-visual'));
  layers.forEach(layer=>{layer.isLoaded=true;});deck.redraw();assert.equal(states.at(-1),true);
  assert(deck.draws.at(-1).layers.includes('map/annotation-visual'));
  scene.setCursorTime('timeline',100);layers=registry.build(scene.current,scene.clock.current);backend.render(scene.current,layers);
  assert.equal(states.at(-1),true,'Cursor changes preserve annotation ownership');
  scene.setAnnotationGeometry({...geometry});layers=registry.build(scene.current,scene.clock.current);backend.render(scene.current,layers);
  assert.equal(states.at(-1),false,'Edited geometry retains legacy visuals until GPU buffers load');
  layers.forEach(layer=>{layer.isLoaded=true;});deck.redraw();assert.equal(states.at(-1),true);
  scene.setVisibility({...scene.current.visibility,annotations:false});layers=registry.build(scene.current,scene.clock.current);backend.render(scene.current,layers);
  assert.equal(states.at(-1),false);
  scene.setVisibility({...scene.current.visibility,annotations:true});layers=registry.build(scene.current,scene.clock.current);backend.render(scene.current,layers);
  assert.equal(states.at(-1),false,'Showing annotations waits for the restored buffers');
  layers.forEach(layer=>{layer.isLoaded=true;});deck.redraw();assert.equal(states.at(-1),true);
  const previous=console.error;console.error=()=>{};
  try{deck.props.onError(new Error('device lost'));}finally{console.error=previous;}
  assert.equal(states.at(-1),false);assert(!deck.draws.at(-1).layers.includes('map/annotation-visual'));
  backend.destroy();assert.equal(deck.finalized,1);
}

// Label consumers use canonical scene points and batched backend projection.
{
  const {annotationLabelPoints}=load('AnnotationGeometry');
  const geometry={type:'FeatureCollection',features:[
    {type:'Feature',id:'point',properties:{id:'point',name:'Place',color:'#123456',selected:true},geometry:{type:'Point',coordinates:[1,2,900]}},
    {type:'Feature',id:'draft',properties:{},geometry:{type:'Point',coordinates:[3,4]}},
    {type:'Feature',id:'invalid',properties:{},geometry:{type:'Point',coordinates:[NaN,4]}},
    {type:'Feature',id:'route',properties:{},geometry:{type:'LineString',coordinates:[[1,2],[3,4]]}},
  ]};
  const points=annotationLabelPoints(geometry);
  assert.equal(points.length,1);assert.equal(points[0].id,'point');assert.equal(points[0].selected,true);
  assert.equal(points[0].coordinate,geometry.features[0].geometry.coordinates);
  assert.equal(annotationLabelPoints(geometry),points,'Clock and cursor updates do not copy label data');
  const {ReplayProjection}=load('ReplayProjection');
  const projection=new ReplayProjection();
  assert.equal(projection.forView('map'),undefined);
  let invalidations=0;const stop=projection.subscribe(()=>invalidations++);
  const provider=view=>view==='map'?coordinate=>({x:coordinate[0]*10,y:coordinate[1]*10}):null;
  const first=projection.attach(provider),second=projection.attach(provider);first();
  const project=projection.forView('map');assert.deepEqual({...project([1,2])},{x:10,y:20});
  assert.equal(project([NaN,2]),null);assert.equal(projection.forView('timeline'),null);
  second();assert.equal(projection.forView('map'),undefined);assert.equal(invalidations,3);stop();
  const scene=new ReplayScene(),registry=new (load('LayerRegistry').ReplayLayerRegistry)();let measurements=0;
  const parent={parentElement:{querySelector:()=>null},getBoundingClientRect:()=>{measurements++;return{left:31,top:47,right:131,bottom:147,width:100,height:100};}};
  const backend={setViews:()=>{},render:()=>{},pick:()=>null,getProjection:()=>coordinate=>({x:coordinate[0]*10,y:coordinate[1]*10}),destroy:()=>{}};
  const engine=new (load('ReplayRenderEngine').ReplayRenderEngine)(parent,scene,backend,registry);
  const batch=scene.projection.forView('map'),before=measurements;
  assert.deepEqual({...batch([1,2])},{x:41,y:67});batch([2,3]);batch([3,4]);assert.equal(measurements,before,'A label batch measures its DOM origin only once');
  engine.destroy();assert.equal(scene.projection.forView('map'),undefined);
}

// --- Footprint LOD policy ------------------------------------------------
{
  const {compileFootprintPaths,FOOTPRINT_BREAK_DURATION}=load('FootprintGeometry');
  const raw=[0,0,2,4,4,0,8,0,10,0];
  const paths=compileFootprintPaths(raw,[0,1000,2000,FOOTPRINT_BREAK_DURATION+3000,FOOTPRINT_BREAK_DURATION+4000]);
  assert.equal(paths.length,2);
  assert.deepEqual([...paths[0][1]],[2,2]);
  assert.deepEqual([...paths[0][0]],[0,0]);
  assert.equal(raw[3],4);
  const crossing=compileFootprintPaths([179.9,0,-179.9,0],[0,1000]);
  assert(Math.abs(crossing[0][1][0]-180.1)<1e-9);
  const invalid=compileFootprintPaths([0,0,1,0,NaN,0,2,0,3,0],[0,1,2,3,4]);
  assert.equal(invalid.length,2);
  assert.equal(invalid[0].length,2);
}
const lod = loadModule(path.join(
  'apps', 'desktop', 'src', 'renderer', 'features', 'map', 'footprintLod.ts',
));
const crossingSpacing=lod.medianAnchoredScreenSpacing([179.99,0,-179.99,0],[0,1000],10,0,{west:179,east:-179,south:-1,north:1});
assert(crossingSpacing>0 && crossingSpacing<100);
const wrappedSpacing=lod.medianAnchoredScreenSpacing([179.99,0,-179.99,0],[0,1000],10,0,{west:179,east:181,south:-1,north:1});
assert.equal(wrappedSpacing,crossingSpacing);

// Web Mercator metres per pixel: zoom 0 at the equator is earth / 512; at
// latitude 60 the cosine factor halves it.
assert.ok(Math.abs(lod.footprintMetersPerPixel(0, 0) - 40075016.686 / 512) < 1e-6);
assert.ok(Math.abs(lod.footprintMetersPerPixel(0, 60) / (40075016.686 / 512) - 0.5) < 1e-9);

// A stationary 1 Hz stack collapses to its first anchor at coarse thinning.
const stationaryCount = 10;
const stationary = {
  coordinates: Array.from({length: stationaryCount * 2}, (_, i) => (i % 2) * 0),
  timestamps: Array.from({length: stationaryCount}, (_, i) => i * 1000),
};
assert.deepEqual(
  [...lod.decimateFootprintCoordinates(stationary.coordinates, stationary.timestamps, 10)],
  [0, 0],
);

// A dwell longer than the time gap keeps a new anchor even without movement,
// so a separate visit still accumulates density.
const dwellCount = 71; // 0..70 s
const dwell = {
  coordinates: Array.from({length: dwellCount * 2}, () => 0),
  timestamps: Array.from({length: dwellCount}, (_, i) => i * 1000),
};
assert.equal(
  lod.decimateFootprintCoordinates(dwell.coordinates, dwell.timestamps, 10).length,
  6, // anchors at 0 s, 31 s, 62 s
);
assert.deepEqual(
  [...lod.decimateFootprintCoordinates([0, 0, 0, 0], [0, 60000], 10, 90000)],
  [0, 0],
);

// Movement beyond the radius keeps the point; the radius always measures from
// the last KEPT anchor, so sub-threshold steps merge onto it.
const degreePer30M = (30 * 360) / 40075016.686;
const movingCoordinates = Array.from(
  {length: 5},
  (_, i) => [i * degreePer30M, 0],
).flat();
const movingTimestamps = [0, 1000, 2000, 3000, 4000];
assert.equal(
  lod.decimateFootprintCoordinates(movingCoordinates, movingTimestamps, 25).length,
  10,
);
const degreePer6M = (6 * 360) / 40075016.686;
const shortSteps = Array.from({length: 6}, (_, i) => [i * degreePer6M, 0]).flat();
const shortKept = [...lod.decimateFootprintCoordinates(shortSteps, movingTimestamps.concat([5000]), 10)];
assert.deepEqual(shortKept, [0, 0, 2 * degreePer6M, 0, 4 * degreePer6M, 0]);

// A recording break always starts a new anchor regardless of distance.
assert.deepEqual(
  [...lod.decimateFootprintCoordinates([0, 0, 0, 0], [0, 6 * 60 * 1000], 10)],
  [0, 0, 0, 0],
);

// Empty / single-point inputs are safe.
assert.deepEqual([...lod.decimateFootprintCoordinates([], [], 10)], []);
assert.deepEqual([...lod.decimateFootprintCoordinates([1, 2], [0], 10)], [1, 2]);

// LOD band edges track the sprite diameter. At zoom >= 14 the CSS diameter is
// 4 px: line enter at one diameter, coarse enter at 0.45 diameter.
const band4 = lod.footprintLodBandPoints(4);
assert.equal(band4.lineEnter, 4);
assert.equal(band4.lineExit, 2.8);
assert.equal(band4.coarseEnter, 1.8);
assert.equal(band4.coarseExit, 2.4);
assert.equal(lod.footprintCoarseTargetPx(4), 3);
assert.equal(lod.footprintCoarseTargetPx(1), 1.2); // floor at far zoom

// LOD selection: strong spacing jumps straight across a level, gradual changes
// honour the exit hysteresis, missing spacing keeps the current level.
const D4 = 4;
assert.equal(lod.selectFootprintLod('points', null, D4), 'points');
assert.equal(lod.selectFootprintLod('line', null, D4), 'line');
assert.equal(lod.selectFootprintLod('coarse', null, D4), 'coarse');
assert.equal(lod.selectFootprintLod('points', 6, D4), 'line');
assert.equal(lod.selectFootprintLod('points', 4, D4), 'line'); // enter boundary = diameter
assert.equal(lod.selectFootprintLod('points', 1, D4), 'coarse');
assert.equal(lod.selectFootprintLod('points', 1.8, D4), 'coarse'); // enter boundary
assert.equal(lod.selectFootprintLod('points', 3, D4), 'points');
assert.equal(lod.selectFootprintLod('line', 3, D4), 'line');
assert.equal(lod.selectFootprintLod('line', 2.8, D4), 'points'); // exit boundary
assert.equal(lod.selectFootprintLod('line', 1, D4), 'coarse'); // direct zoom-out jump
assert.equal(lod.selectFootprintLod('coarse', 2.2, D4), 'coarse');
assert.equal(lod.selectFootprintLod('coarse', 2.4, D4), 'points'); // exit boundary
assert.equal(lod.selectFootprintLod('coarse', 6, D4), 'line'); // direct zoom-in jump
// At zoom 12 the diameter is ~3.4 px, so a 3.5 px gap already connects instead
// of stranding the track as tiny dots (the fixed-5px regression case).
const D12 = 3.4;
assert.equal(lod.selectFootprintLod('points', 3.5, D12), 'line');
assert.equal(lod.selectFootprintLod('points', 3.5, D4), 'points');

// Anchored median spacing at zoom 16 on the equator: 3 m steps (~2.51 px) are
// all retained and land in the raw-points band.
const zoom16Mpp = lod.footprintMetersPerPixel(16, 0);
const step3M = (3 * 360) / 40075016.686;
const spacedTrack = {
  coordinates: Array.from({length: 21}, (_, i) => [i * step3M, 0]).flat(),
  timestamps: Array.from({length: 21}, (_, i) => i * 1000),
};
const wideBounds = {west: -1, east: 1, south: -1, north: 1};
const spacedMedian = lod.medianAnchoredScreenSpacing(
  spacedTrack.coordinates, spacedTrack.timestamps, 16, 0, wideBounds,
);
assert.ok(Math.abs(spacedMedian - 3 / zoom16Mpp) < 0.01, String(spacedMedian));
assert.equal(lod.selectFootprintLod('points', spacedMedian, D4), 'points');

// 0.3 m high-rate steps merge onto ~1.2 m anchors (~1 px): the view reads as
// overlapping, and a single traversal drops to the coarse LOD instead of
// stacking into fake density.
const step03M = (0.3 * 360) / 40075016.686;
const denseTrack = {
  coordinates: Array.from({length: 40}, (_, i) => [i * step03M, 0]).flat(),
  timestamps: Array.from({length: 40}, (_, i) => i * 1000),
};
const denseMedian = lod.medianAnchoredScreenSpacing(
  denseTrack.coordinates, denseTrack.timestamps, 16, 0, wideBounds,
);
assert.ok(denseMedian > 0.9 && denseMedian < 1.5, String(denseMedian));
assert.equal(lod.selectFootprintLod('points', denseMedian, D4), 'coarse');

// A stationary dwell stack before movement must not drag the median down.
const dwellThenMove = {
  coordinates: [
    ...Array.from({length: 10}, () => [0, 0]),
    ...Array.from({length: 9}, (_, i) => [(i + 1) * degreePer30M, 0]),
  ].flat(),
  timestamps: Array.from({length: 19}, (_, i) => i * 1000),
};
const dwellMedian = lod.medianAnchoredScreenSpacing(
  dwellThenMove.coordinates, dwellThenMove.timestamps, 16, 0, wideBounds,
);
assert.ok(Math.abs(dwellMedian - 30 / zoom16Mpp) < 0.2, String(dwellMedian));
assert.equal(lod.selectFootprintLod('points', dwellMedian, D4), 'line');

// Pairs with either end outside the viewport are excluded; no visible pair
// means the caller keeps its current LOD.
const offscreen = {
  coordinates: [0, 0, 0.01, 0, 0.02, 0],
  timestamps: [0, 1000, 2000],
};
assert.equal(
  lod.medianAnchoredScreenSpacing(
    offscreen.coordinates, offscreen.timestamps, 16, 0,
    {west: -0.001, east: 0.001, south: -0.001, north: 0.001},
  ),
  null,
);

async function checkFrameBarrier() {
  const {waitForMapFrame}=load('MapFrameBarrier');
  const listeners=new Set();
  const map={on:(event,listener)=>listeners.add(listener),off:(event,listener)=>listeners.delete(listener),triggerRepaint:()=>{}};
  const controller=new AbortController();
  const rendered=waitForMapFrame(map,controller.signal);
  assert.equal(listeners.size,1);
  for(const listener of [...listeners])listener();
  assert.equal(await rendered,true);
  assert.equal(listeners.size,0);
  const cancelled=waitForMapFrame(map,controller.signal);
  controller.abort();
  assert.equal(await cancelled,false);
  assert.equal(listeners.size,0);
  assert.equal(await waitForMapFrame(map,controller.signal),false);
}
async function checkOfflinePump() {
  const {OfflineFramePlan}=loadModule(path.join('apps','desktop','src','shared','overlayExport.ts'));
  const {renderOfflineFrames}=load('export/OfflineFramePump');
  const options={width:16,height:16,fps:3,bitrate:1000000,start:1000,end:3500,segmentMilliseconds:1000};
  const plan=new OfflineFramePlan(options);
  assert.equal(plan.totalFrames,8);assert.equal(plan.segmentCount,3);
  assert.deepEqual([0,1,2].map(segment=>plan.segmentFrames(segment)),[3,3,2]);
  assert.equal(plan.frame(0,0).timestamp,1000);assert.equal(plan.frame(1,0).timestamp,2000);
  assert(plan.frame(2,1).timestamp<3500);assert.equal(plan.frame(2,1).progress,1);
  assert.throws(()=>plan.frame(0,3),/range/);
  for(const invalid of [{width:3},{fps:0},{bitrate:NaN},{end:1000},{segmentMilliseconds:0}]) assert.throws(()=>new OfflineFramePlan({...options,...invalid}),/Invalid/);
  options.width=32;assert.equal(plan.options.width,16,'A running export freezes its settings');
  const epoch=1800000000000;
  const precise=new OfflineFramePlan({...options,start:epoch,end:epoch+1000,fps:60});
  assert.equal(precise.totalFrames,60);assert.equal(precise.frame(0,59).timestamp,epoch+59*1000/60);
  const clock=new ReplayClock(), interactive=new ReplayClock(), controller=new AbortController();
  const events=[],progress=[];let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const pending=renderOfflineFrames(plan,clock,controller.signal,{
    render:async work=>{events.push(`r${work.frame}`);assert.equal(clock.current.time,work.timestamp);assert.equal(clock.current.frame,work.frame);if(work.frame===0)await gate;},
    encode:async work=>{events.push(`e${work.frame}`);},finishSegment:async segment=>{events.push(`s${segment}`);},progress:value=>progress.push(value),
  });
  assert.deepEqual(events,['r0'],'Encoding waits for rendering to finish');release();await pending;
  assert.deepEqual(events,['r0','e0','r1','e1','r2','e2','s0','r3','e3','r4','e4','r5','e5','s1','r6','e6','r7','e7','s2']);
  assert.equal(progress.at(-1),1);assert.equal(clock.current.frame,7);assert.equal(clock.current.mode,'export');
  assert.equal(interactive.current.time,null,'Export stepping does not change the interactive clock');
  const cancelled=new AbortController();let encoded=0,finished=0;
  await assert.rejects(renderOfflineFrames(plan,new ReplayClock(),cancelled.signal,{
    render:async()=>cancelled.abort(new Error('cancelled in render')),encode:async()=>{encoded++;},finishSegment:async()=>{finished++;},
  }),/cancelled/);
  assert.equal(encoded,0);assert.equal(finished,0);
  const failure=new Error('encoder failed');
  await assert.rejects(renderOfflineFrames(plan,new ReplayClock(),new AbortController().signal,{
    render:async()=>{},encode:async()=>{throw failure;},finishSegment:async()=>{finished++;},
  }),/encoder failed/);
  assert.equal(finished,0);
}
async function checkRenderCompletion() {
  const {RenderCompletion}=load('RenderCompletion');
  const frames=new RenderCompletion(), controller=new AbortController();
  frames.submit();let resolved=false;
  const pending=frames.wait(controller.signal).then(value=>{resolved=true;return value;});
  await Promise.resolve();assert.equal(resolved,false);
  frames.complete(1);assert.equal(await pending,true);
  frames.submit();const cancelled=frames.wait(controller.signal);controller.abort();assert.equal(await cancelled,false);
  const failure=new RenderCompletion();failure.submit();const failed=failure.wait(new AbortController().signal);failure.fail();assert.equal(await failed,false);
  assert.equal(await failure.wait(new AbortController().signal),false);
  const timeout=new RenderCompletion();timeout.submit();assert.equal(await timeout.wait(new AbortController().signal,0),false);
  const scene=new ReplayScene(), registry=new (load('LayerRegistry').ReplayLayerRegistry)();
  let acknowledged=0,disposed=0;
  const backend={setViews:views=>assert.equal(views[0].id,'map'),render:()=>{},pick:()=>null,waitForFrame:async()=>{acknowledged++;return true;},destroy:()=>{disposed++;}};
  const engine=new (load('ReplayRenderEngine').ReplayRenderEngine)({},scene,backend,registry,{views:[{id:'map',kind:'map',x:0,y:0,width:320,height:240}],picking:false});
  assert.equal(scene.picking.pick({viewId:'map',x:0,y:0}),undefined,'Offscreen renderers do not replace interactive picking');
  assert.equal(await engine.renderComplete(new AbortController().signal),true);assert.equal(acknowledged,1);
  engine.destroy();assert.equal(disposed,1);assert.equal(await engine.renderComplete(new AbortController().signal),false);
  let renders=0,builds=0;
  const batchedScene=new ReplayScene(), batchedRegistry=new (load('LayerRegistry').ReplayLayerRegistry)();
  batchedRegistry.register({id:'export',views:['map'],order:0,build:()=>{builds++;return [];}});
  const batched=new (load('ReplayRenderEngine').ReplayRenderEngine)({},batchedScene,{...backend,render:()=>{renders++;}},batchedRegistry,{views:[{id:'map',kind:'map',x:0,y:0,width:320,height:240}],picking:false,syncCamera:false});
  batchedScene.clock.step(1000,0);batchedScene.setMapViewState({longitude:1,latitude:2,zoom:3,bearing:0,pitch:0});
  assert.equal(renders,0,'Offline camera and clock changes wait for one explicit frame submission');
  await batched.renderComplete(new AbortController().signal);assert.equal(renders,1);assert.equal(builds,1);batched.destroy();
}
Promise.all([checkFrameBarrier(),checkOfflinePump(),checkRenderCompletion()]).then(()=>console.log('Render engine passed: shared state, LOD, visibility, channels, geometry, map frame barrier and deterministic offline frame pump.')).catch(error=>{console.error(error);process.exitCode=1;});
