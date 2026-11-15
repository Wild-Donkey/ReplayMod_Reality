const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const ts=require('typescript');
function load(file){const module={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(require,module,module.exports);return module.exports;}
const {refineMotionAlignment}=load('packages/media/src/motion-alignment.ts');
const {shiftVideoTimestamps}=load('packages/media/src/video-timestamps.ts');
const heading=t=>.4*Math.sin(t/11)+.15*Math.sin(t/4);
const samples=Array.from({length:1801},(_,i)=>{const t=i*.05,h=heading(t);return {timeSeconds:t,quaternion:[Math.cos(h/2),0,0,Math.sin(h/2)]};});
const gps=[];let x=0,y=0;
for(let i=0;i<=90;i++){gps.push({timeSeconds:i+102,longitude:x,latitude:y});const h=heading(i+.5);x+=Math.sin(h)*.0002;y+=Math.cos(h)*.0002;}
const refined=refineMotionAlignment(samples,gps,100);
assert.equal(refined.refined,true,JSON.stringify(refined));assert.equal(refined.offsetSeconds,102);
assert.equal(refineMotionAlignment(samples,gps.map(p=>({...p,timeSeconds:p.timeSeconds-200})),-100).offsetSeconds,-98);
assert.equal(refineMotionAlignment(samples,gps,102).offsetSeconds,102);
assert.equal(refineMotionAlignment([],gps,100).offsetSeconds,100);
assert.equal(refineMotionAlignment(samples,gps.map(p=>({...p,latitude:p.timeSeconds*.0002,longitude:0})),100).refined,false);
assert.equal(refineMotionAlignment(samples,gps,80).offsetSeconds,80,'must not jump outside the local window');
function atom(type,...parts){const b=Buffer.concat(parts);const h=Buffer.alloc(8);h.writeUInt32BE(b.length+8);h.write(type,4);return Buffer.concat([h,b]);}
function dated(type,v=0){const p=Buffer.alloc(v?24:16);p[0]=v;if(v){p.writeBigUInt64BE(3900000000n,4);p.writeBigUInt64BE(3900000000n,12);}else{p.writeUInt32BE(3900000000,4);p.writeUInt32BE(3900000000,8);}return atom(type,p);}
function fixture(drop=false){const code=Buffer.alloc(4);code.writeInt32BE(1000);const mdat=atom('mdat',code,Buffer.from('DO NOT ALTER VIDEO AUDIO OR DJI PAYLOAD'));
 const h=Buffer.alloc(12);h.write('tmcd',8);
 const entry=Buffer.alloc(26);entry.writeUInt32BE(drop?1:0,12);entry.writeUInt32BE(25,16);entry.writeUInt32BE(1,20);entry[24]=25;
 const d=Buffer.alloc(8);d.writeUInt32BE(1,4);
 const sizes=Buffer.alloc(12);sizes.writeUInt32BE(4,4);sizes.writeUInt32BE(1,8);
 const offsets=Buffer.alloc(12);offsets.writeUInt32BE(1,4);offsets.writeUInt32BE(8,8);
 const table=atom('stbl',atom('stsd',d,atom('tmcd',entry)),atom('stsz',sizes),atom('stco',offsets));
 const media=atom('mdia',dated('mdhd'),atom('hdlr',h),atom('minf',table));
 return Buffer.concat([mdat,atom('moov',dated('mvhd'),atom('trak',dated('tkhd',1),media))]);}
(async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-alignment-test-'));try{
 const file=path.join(dir,'test.mp4'),before=fixture();fs.writeFileSync(file,before);
 const result=await shiftVideoTimestamps(file,-30);const after=fs.readFileSync(file);
 assert.equal(result.timecodeUpdated,true);assert.equal(after.length,before.length);assert.equal(after.readInt32BE(8),250);
 assert.deepEqual(after.subarray(12,8+4+'DO NOT ALTER VIDEO AUDIO OR DJI PAYLOAD'.length),before.subarray(12,8+4+'DO NOT ALTER VIDEO AUDIO OR DJI PAYLOAD'.length));
 assert.deepEqual(fs.readFileSync(result.backupPath),before);
 await shiftVideoTimestamps(file,30);assert.deepEqual(fs.readFileSync(file),before,'inverse offset restores every original byte');
 const bad=path.join(dir,'unsupported.mp4'),badBefore=fixture(true);fs.writeFileSync(bad,badBefore);
 await assert.rejects(()=>shiftVideoTimestamps(bad,-30),/时间码格式/);assert.deepEqual(fs.readFileSync(bad),badBefore);
 await assert.rejects(()=>shiftVideoTimestamps(file,NaN));await assert.rejects(()=>shiftVideoTimestamps(file,.5));
 const real=process.argv[2];if(real){const copy=path.join(dir,'real.MP4');fs.copyFileSync(real,copy);const saved=await shiftVideoTimestamps(copy,-30);const actual=fs.readFileSync(copy),original=fs.readFileSync(real);assert.equal(actual.length,original.length);let changes=0;for(let i=0;i<actual.length;i++)if(actual[i]!==original[i])changes++;assert.ok(changes>0&&changes<200,`Unexpected ${changes} changed bytes`);assert.deepEqual(fs.readFileSync(saved.backupPath),original);console.log(`Real DJI copy: ${changes} changed bytes; size and backup verified.`);const {execFileSync}=require('node:child_process');const probe=process.env.FFPROBE||'ffprobe';const info=JSON.parse(execFileSync(probe,['-v','error','-show_entries','format_tags=creation_time:stream=index,codec_tag_string:stream_tags=timecode','-of','json',copy],{encoding:'utf8'}));assert.equal(info.format.tags.creation_time,'2026-11-01T08:43:32.000000Z');assert.equal(info.streams.find(s=>s.codec_tag_string==='tmcd').tags.timecode,'00:45:47:08');console.log('Real DJI copy: creation time and existing tmcd counter shifted by −30 seconds.');}
 console.log('Alignment passed: injected offset, local search, straight/missing fallback, date versions, timecode, byte preservation, backup and rejected format.');
}finally{fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
