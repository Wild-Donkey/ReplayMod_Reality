const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
function compile(file){return ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../../apps/desktop/src/'+file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;}
const display={exports:{}};vm.runInNewContext(compile('shared/display.ts'),{exports:display.exports});
let info=null;const events=new Map(),writes=[],media={matches:true,addEventListener(){},removeEventListener(){}},navigator={gpu:{}};
const mod={exports:{}};
vm.runInNewContext(compile('renderer/shared/displayHDR.ts'),{
 exports:mod.exports,require:name=>name==='react'?{}:name.includes('shared/display')?display.exports:{readCached:()=>true,writeCached:(...args)=>writes.push(args)},
 navigator,matchMedia:()=>media,setInterval:()=>1,clearInterval(){},document:{hidden:false},
 window:{replaymod:{getDisplayHDR:async()=>info},addEventListener:(name,handler)=>events.set(name,handler),removeEventListener:name=>events.delete(name)}
});
const {getHDRState,setHDREnabled,watchDisplayHDR,currentHDRHeadroom}=mod.exports;
(async()=>{
 assert.equal(getHDRState().supported,null);
 info={potentialHeadroom:16,currentHeadroom:2.67,label:'HDR'};const stop=watchDisplayHDR(()=>{});
 const tick=()=>new Promise(resolve=>setImmediate(resolve));await tick();
 assert.equal(getHDRState().active,true);assert.equal(currentHDRHeadroom(),2.67);
 setHDREnabled(false);assert.equal(getHDRState().active,false);assert.equal(currentHDRHeadroom(),1);assert.equal(writes.at(-1)[1],false);
 info={potentialHeadroom:1,currentHeadroom:1,label:'SDR'};await events.get('focus')();
 assert.equal(getHDRState().supported,false,'native SDR detection overrides a stale high media query');
 const saved=writes.length;setHDREnabled(true);assert.equal(writes.length,saved,'disabled switch cannot overwrite preference');
 info={potentialHeadroom:16,currentHeadroom:1,label:'HDR'};await events.get('focus')();
 assert.equal(getHDRState().supported,true);assert.equal(getHDRState().active,false,'retain disabled preference across displays');
 setHDREnabled(true);assert.equal(getHDRState().active,true,'potential capability is distinct from temporary available headroom');
 navigator.gpu=undefined;await events.get('focus')();assert.equal(getHDRState().supported,false);
 stop();assert.equal(events.size,0);
 console.log('HDR settings passed: persistent preference, disabled control, display transitions, SDR output limit, capability/headroom distinction and cleanup.');
})().catch(error=>{console.error(error);process.exitCode=1});
