const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const mod = {exports:{}};
const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../apps/desktop/src/renderer/render-engine/FootprintDensityPass.ts'), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
vm.runInNewContext(code, {exports:mod.exports, require:()=>({})});
const {footprintExposure, footprintIntensity} = mod.exports;
const samples = values => Float32Array.from(values.flatMap(n=>[n,0,0,0]));
assert.equal(footprintExposure(samples([])), 0);
assert.equal(footprintExposure(samples([0,0,1,1,1])), 0);
const dense = footprintExposure(samples(Array(100).fill(64)));
assert.equal(dense, -4);
assert.equal(footprintExposure(samples([...Array(1000).fill(0),...Array(100).fill(64)])), dense, 'empty map area must not steer exposure');
assert.equal(footprintExposure(samples([...Array(100).fill(1),4096])), 0, 'one extreme hotspot must not darken the whole track');
assert.equal(footprintExposure(samples([...Array(95).fill(1),...Array(5).fill(64)])), -4, 'a small dense district must drive highlight protection');
assert(footprintIntensity(64, dense) < 0.7);
assert(footprintIntensity(32, dense) < footprintIntensity(64, dense), 'repeat-density ordering survives');
console.log('Footprint exposure passed: empty, sparse, dense, empty-area invariance, isolated highlights and density ordering.');

for (const exposure of [-1,-4,-10]) {
  for (const coverage of [0,0.1,0.5,1])
    assert.equal(footprintIntensity(coverage,exposure),footprintIntensity(coverage), 'sparse tracks and antialiased edges retain visibility');
  assert(footprintIntensity(1,exposure)>=0.2-1e-9);
  assert(footprintIntensity(64,exposure)>footprintIntensity(1,exposure));
}
