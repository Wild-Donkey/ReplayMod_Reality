const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const {createHash} = require('node:crypto');
const {performance} = require('node:perf_hooks');
const ts = require('typescript');
const assert = require('node:assert/strict');

function load(file) {
  const module = {exports: {}};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
  }).outputText;
  vm.runInNewContext(code, {
    exports: module.exports, URL, Uint8Array, AbortController, AbortSignal, console,
    require: name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name),
  });
  return module.exports;
}
const {MapResources} = load(path.resolve('apps/desktop/src/main/mapResources.ts'));
const {ResourceCache} = load(path.resolve('apps/desktop/src/main/storage/resourceCache.ts'));
const url = name => 'https://api.maptiler.com/tiles/v3/' + name;
const transit = 'https://loom.cs.uni-freiburg.de/tiles/subway-lightrail/geo/12/3430/1673.mvt';
const key = url => createHash('sha256').update(url).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
function memoryDisk() {
  const values = new Map();
  return {
    values, reads: 0, writes: 0,
    async read(_namespace, key) {this.reads++; return values.get(key) ?? null;},
    async write(_namespace, key, value) {this.writes++; values.set(key, value); return true;},
  };
}
function controlledNetwork() {
  const started = [];
  const pending = new Map();
  return {
    started, pending,
    fetch(url, {signal}) {
      started.push(url);
      const request = deferred();
      pending.set(url, {...request, signal});
      signal.addEventListener('abort', () => request.reject(signal.reason), {once: true});
      return request.promise;
    },
    complete(url) {pending.get(url).resolve(new Response(new Uint8Array([1, 2, 3])));},
  };
}

async function checkSharing() {
  const cache = memoryDisk(), network = controlledNetwork();
  const resources = new MapResources(cache, network.fetch);
  const first = new AbortController();
  const a = resources.load(url('shared'), false, first.signal);
  const b = resources.load(url('shared'));
  await tick();
  assert.equal(cache.reads, 1);
  assert.equal(network.started.length, 1);
  first.abort();
  await assert.rejects(a, {name: 'AbortError'});
  assert.equal(network.pending.get(url('shared')).signal.aborted, false, 'Other map carriers still need this tile');
  network.complete(url('shared'));
  assert.deepEqual([...await b], [1, 2, 3]);
  await resources.load(url('shared'));
  assert.equal(cache.reads, 1, 'Repeat requests use memory without another disk lookup');
  assert.equal(network.started.length, 1);

  const abandoned = new AbortController();
  const pending = resources.load(url('abandoned'), false, abandoned.signal);
  await tick();
  abandoned.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  assert(network.pending.get(url('abandoned')).signal.aborted, 'Last consumer aborts the download');
  const retry = resources.load(url('abandoned'));
  await tick();
  network.complete(url('abandoned'));
  await retry;

  const before = cache.reads;
  await assert.rejects(resources.load('https://example.com/tile'));
  await assert.rejects(resources.load(transit, true));
  assert.equal(cache.reads, before, 'URL validation precedes cache access');
}

async function checkQueues() {
  const network = controlledNetwork();
  const resources = new MapResources(memoryDisk(), network.fetch);
  const controllers = Array.from({length: 12}, () => new AbortController());
  const base = controllers.slice(0, 8).map((controller, index) => resources.load(url('base-' + index), false, controller.signal));
  const queuedController = new AbortController();
  const queued = resources.load(url('obsolete'), false, queuedController.signal);
  const metadata = resources.load(url('tiles.json'));
  const rails = controllers.slice(8).map((controller, index) => resources.load(transit.replace('/3430/', '/' + (3430 + index) + '/'), false, controller.signal));
  const outcomes = Promise.allSettled([...base, queued, metadata, ...rails]);
  await tick();
  assert.equal(network.started.length, 12, 'Slow transit downloads do not consume the eight basemap slots');
  assert(!network.started.includes(url('obsolete')));
  assert(!network.started.includes(url('tiles.json')));
  queuedController.abort();
  network.complete(url('base-0'));
  await tick();
  assert.equal(network.started.at(-1), url('tiles.json'), 'Metadata starts ahead of queued tiles');
  assert(!network.started.includes(url('obsolete')), 'Aborted queued requests never use the network');
  network.complete(url('tiles.json'));
  controllers.forEach(controller => controller.abort());
  await outcomes;
  assert.equal(network.started.length, 13);
}

async function checkRefreshAndPersistence() {
  const cache = memoryDisk(), network = controlledNetwork();
  const saved = {at: Date.now() - 8 * 86400_000, data: new Uint8Array([8])};
  cache.values.set(key(url('old')), saved);
  const resources = new MapResources(cache, network.fetch);
  assert.deepEqual([...await resources.load(url('old'))], [8], 'Expired disk tiles display immediately');
  assert.equal(network.started.length, 1);
  assert.deepEqual([...await resources.load(url('old'))], [8]);
  assert.equal(network.started.length, 1, 'Only one background refresh is allowed');
  network.pending.get(url('old')).reject(new Error('offline'));
  await tick();
  assert.deepEqual([...await resources.load(url('old'))], [8]);
  assert.equal(network.started.length, 1, 'Failed refreshes have a cooldown');

  const batchNetwork = controlledNetwork();
  const batch = new MapResources(cache, batchNetwork.fetch);
  await batch.load(url('old'), true);
  assert.equal(batchNetwork.started.length, 0, 'Terrain batch input retains indefinite disk reuse');

  const write = deferred();
  const slowDisk = {...memoryDisk(), write: () => write.promise};
  const immediate = new MapResources(slowDisk, async () => new Response(new Uint8Array([7])));
  const downloaded = await Promise.race([
    immediate.load(url('new')),
    new Promise((_, reject) => setTimeout(() => reject(Error('Rendering waited for disk write')), 1000)),
  ]);
  assert.equal(downloaded[0], 7);
  write.resolve(true);

  let downloads = 0;
  const empty = new MapResources(memoryDisk(), async () => {downloads++; return new Response(null, {status: 404});});
  assert.equal((await empty.load(transit)).length, 0);
  assert.equal((await empty.load(transit)).length, 0);
  assert.equal(downloads, 1, 'Missing transit tiles are cached');

  const evictionCache = memoryDisk();
  const bounded = new MapResources(evictionCache, async () => new Response(new Uint8Array([1])));
  for (let index = 0; index < 513; index++) await bounded.load(url('bounded-' + index));
  const reads = evictionCache.reads;
  await bounded.load(url('bounded-0'));
  assert.equal(evictionCache.reads, reads + 1, 'Memory entry count is bounded and evicted tiles remain on disk');
}

async function benchmarkReuse() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-map-resource-bench-'));
  try {
    const disk = new ResourceCache(directory, 16 * 1024 * 1024, async () => {});
    const urls = Array.from({length: 128}, (_, index) => url('bench-' + index));
    for (const address of urls) await disk.write('maps', key(address), {at: Date.now(), data: new Uint8Array(64 * 1024)});
    let reads = 0;
    const resources = new MapResources({
      read: (...args) => {reads++; return disk.read(...args);},
      write: (...args) => disk.write(...args),
    }, async () => {throw Error('Warm cache must not download');});
    await Promise.all(urls.map(address => resources.load(address)));
    const repeated = [...urls, ...urls, ...urls];
    const before = performance.now();
    await Promise.all(repeated.map(address => disk.read('maps', key(address))));
    const diskMs = performance.now() - before;
    const warm = performance.now();
    await Promise.all(repeated.map(address => resources.load(address)));
    const memoryMs = performance.now() - warm;
    assert.equal(reads, urls.length);
    console.log('Warm tile reuse benchmark (384 requests, 64 KiB each):', {diskMs: +diskMs.toFixed(1), memoryMs: +memoryMs.toFixed(1), repeatedDiskReads: 0});
    await disk.drain();
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
}

(async () => {
  await checkSharing();
  await checkQueues();
  await checkRefreshAndPersistence();
  await benchmarkReuse();
  console.log('Map resources passed: memory reuse, shared consumers, active/queued cancellation, provider isolation, stale refresh, nonblocking writes and bounded LRU.');
})().catch(error => {console.error(error); process.exitCode = 1;});
