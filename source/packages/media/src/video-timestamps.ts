import { open, copyFile, rename, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";

interface Atom { type: string; start: number; end: number; data: number }
interface Patch { offset: number; before: Buffer; after: Buffer }
function atoms(buffer: Buffer, start: number, end: number): Atom[] {
  const result: Atom[]=[];
  while(start+8<=end) {
    let size=buffer.readUInt32BE(start),header=8;
    if(size===1) { if(start+16>end) throw new Error("视频容器头不完整。"); size=Number(buffer.readBigUInt64BE(start+8));header=16; }
    if(size===0) size=end-start;
    if(!Number.isSafeInteger(size)||size<header||start+size>end) throw new Error("视频容器结构无效。");
    result.push({type:buffer.toString("ascii",start+4,start+8),start,end:start+size,data:start+header});start+=size;
  }
  return result;
}
const need=(items:Atom[],type:string) => { const atom=items.find(a=>a.type===type);if(!atom) throw new Error(`视频缺少 ${type}，无法安全修改时间。`);return atom; };

/** Patch only fixed-size date fields and existing tmcd counters; never remux DJI tracks. */
export async function shiftVideoTimestamps(sourcePath:string,offsetSeconds:number):Promise<{backupPath:string;timecodeUpdated:boolean}> {
  if(!Number.isSafeInteger(offsetSeconds)||Math.abs(offsetSeconds)>86400) throw new Error("偏移必须是一天以内的整数秒。");
  const original=await stat(sourcePath),handle=await open(sourcePath,"r");
  const patches:Patch[]=[];let timecodeUpdated=false;
  try {
    let position=0,moovOffset=-1,moov:Buffer|undefined;
    while(position+8<=original.size) {
      const header=Buffer.alloc(16);await handle.read(header,0,Math.min(16,original.size-position),position);
      let size=header.readUInt32BE(0);const type=header.toString("ascii",4,8);
      if(size===1) size=Number(header.readBigUInt64BE(8));if(size===0) size=original.size-position;
      if(!Number.isSafeInteger(size)||size<8||position+size>original.size) throw new Error("视频容器结构无效。");
      if(type==="moov") { if(size>128*1024*1024) throw new Error("视频索引过大，暂不支持修改。");moovOffset=position;moov=Buffer.alloc(size);const r=await handle.read(moov,0,size,position);if(r.bytesRead!==size)throw new Error("视频索引读取不完整。");break; }
      position+=size;
    }
    if(!moov) throw new Error("未找到视频时间索引。");
    const buffer=moov,root=atoms(buffer,0,buffer.length)[0];
    const children=(a:Atom)=>atoms(buffer,a.data,a.end);
    const patch=(offset:number,before:Buffer,after:Buffer)=>patches.push({offset,before:Buffer.from(before),after});
    const dates=(a:Atom)=>{
      const version=buffer[a.data];if(version!==0&&version!==1)throw new Error("不支持此时间字段版本。");
      const width=version===1?8:4;
      for(let i=0;i<2;i++) {
        const at=a.data+4+i*width;if(at+width>a.end)throw new Error("时间字段不完整。");
        const old=width===8?buffer.readBigUInt64BE(at):BigInt(buffer.readUInt32BE(at));
        if(old===0n) continue;
        const value=old+BigInt(offsetSeconds),limit=width===8?0xffffffffffffffffn:0xffffffffn;
        if(value<0||value>limit)throw new Error("校正时间超出容器可用范围。");
        const after=Buffer.alloc(width);if(width===8)after.writeBigUInt64BE(value);else after.writeUInt32BE(Number(value));
        patch(moovOffset+at,buffer.subarray(at,at+width),after);
      }
    };
    const top=children(root);dates(need(top,"mvhd"));
    for(const trak of top.filter(a=>a.type==="trak")) {
      const track=children(trak);dates(need(track,"tkhd"));
      const media=children(need(track,"mdia"));dates(need(media,"mdhd"));
      const handler=need(media,"hdlr");if(buffer.toString("ascii",handler.data+8,handler.data+12)!=="tmcd")continue;
      const table=children(need(children(need(media,"minf")),"stbl"));
      const desc=need(table,"stsd"),entries=atoms(buffer,desc.data+8,desc.end),entry=need(entries,"tmcd");
      if(entry.start+34>entry.end)throw new Error("时间码描述不完整。");
      const flags=buffer.readUInt32BE(entry.start+20),scale=buffer.readUInt32BE(entry.start+24),frameDuration=buffer.readUInt32BE(entry.start+28);
      if(flags&1||!scale||!frameDuration)throw new Error("暂不支持此时间码格式，未修改视频。");
      const sizes=need(table,"stsz"),chunks=table.find(a=>a.type==="stco"||a.type==="co64");
      if(!chunks||buffer.readUInt32BE(sizes.data+8)!==1||buffer.readUInt32BE(chunks.data+4)!==1)throw new Error("暂不支持多样本时间码轨，未修改视频。");
      const sampleSize=buffer.readUInt32BE(sizes.data+4)||buffer.readUInt32BE(sizes.data+12);
      const sampleOffset=chunks.type==="co64"?Number(buffer.readBigUInt64BE(chunks.data+8)):buffer.readUInt32BE(chunks.data+8);
      if(sampleSize!==4||!Number.isSafeInteger(sampleOffset)||sampleOffset<0||sampleOffset+4>original.size)throw new Error("时间码样本无效。");
      const before=Buffer.alloc(4);await handle.read(before,0,4,sampleOffset);
      const frames=before.readInt32BE()+Math.round(offsetSeconds*scale/frameDuration);
      if(frames<-2147483648||frames>2147483647)throw new Error("时间码超出可用范围。");
      const after=Buffer.alloc(4);after.writeInt32BE(frames);patch(sampleOffset,before,after);timecodeUpdated=true;
    }
  } finally { await handle.close(); }
  if(!patches.length)throw new Error("视频没有可修改的时间信息。");
  const temporary=`${sourcePath}.alignment-${randomUUID()}.tmp`,backupPath=`${sourcePath}.before-alignment-${randomUUID()}`;
  try {
    await copyFile(sourcePath,temporary,constants.COPYFILE_EXCL);
    const output=await open(temporary,"r+");
    try { for(const p of patches) {const check=Buffer.alloc(p.before.length);await output.read(check,0,check.length,p.offset);if(!check.equals(p.before))throw new Error("视频已发生变化，请重新载入后对齐。");await output.write(p.after,0,p.after.length,p.offset);}await output.sync(); }
    finally {await output.close();}
    const current=await stat(sourcePath);
    if(current.size!==original.size||current.mtimeMs!==original.mtimeMs)throw new Error("视频已发生变化，请重新载入后对齐。");
    await copyFile(sourcePath,backupPath,constants.COPYFILE_EXCL);
    await rename(temporary,sourcePath);
    return {backupPath,timecodeUpdated};
  } finally { await rm(temporary,{force:true}); }
}
