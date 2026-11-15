import {protocol} from "electron";
import {createReadStream} from "node:fs";
import {stat} from "node:fs/promises";
import {Readable} from "node:stream";
import path from "node:path";

export function registerMediaPreviewScheme() {
  protocol.registerSchemesAsPrivileged([{scheme:"replay-media",privileges:{standard:true,secure:true,stream:true,supportFetchAPI:true}}]);
}
export function installMediaPreviewProtocol(openedPaths:ReadonlySet<string>) {
  protocol.handle("replay-media",async request=>{
    const url=new URL(request.url);
    let sourcePath:string;
    try {sourcePath=decodeURIComponent(url.pathname.slice(1));}catch{return new Response("Invalid path",{status:400});}
    if(url.hostname!=="preview" || !openedPaths.has(sourcePath))return new Response("Not found",{status:404});
    if(!["GET","HEAD"].includes(request.method))return new Response(null,{status:405});
    try {
      const {size}=await stat(sourcePath);
      const range=request.headers.get("range");
      let start=0,end=size-1;
      if(range) {
        const match=/^bytes=(\d*)-(\d*)$/.exec(range);
        if(!match || (!match[1]&&!match[2]))return new Response(null,{status:416,headers:{"Content-Range":`bytes */${size}`}});
        start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
        end=match[1]&&match[2]?Math.min(size-1,Number(match[2])):size-1;
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size)return new Response(null,{status:416,headers:{"Content-Range":`bytes */${size}`}});
      }
      const headers:Record<string,string>={"Content-Type":({".mov":"video/quicktime",".mp4":"video/mp4",".m4a":"audio/mp4",".mp3":"audio/mpeg",".wav":"audio/wav",".flac":"audio/flac",".ogg":"audio/ogg",".aac":"audio/aac",".webm":"video/webm",".mkv":"video/x-matroska"} as Record<string,string>)[path.extname(sourcePath).toLowerCase()] ?? "application/octet-stream","Accept-Ranges":"bytes","Content-Length":String(Math.max(0,end-start+1))};
      if(range)headers["Content-Range"]=`bytes ${start}-${end}/${size}`;
      if(request.method==="HEAD"||size===0)return new Response(null,{status:range?206:200,headers});
      const stream=createReadStream(sourcePath,{start,end});
      const abort=()=>stream.destroy();
      request.signal.addEventListener("abort",abort,{once:true});
      stream.once("close",()=>request.signal.removeEventListener("abort",abort));
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>,{status:range?206:200,headers});
    }catch{return new Response("Video unavailable",{status:404});}
  });
}
