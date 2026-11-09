const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.whenReady().then(async()=>{
 const window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,backgroundThrottling:false}});
 try {
  await window.loadURL('data:text/html,<html></html>');
  const result=await window.webContents.executeJavaScript(`(async()=>{
   const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;
   const ctx=canvas.getContext('2d');
   ctx.fillStyle='#ff0000';ctx.fillRect(0,0,64,64);
   const stream=canvas.captureStream(0),track=stream.getVideoTracks()[0];
   track.requestFrame();await new Promise(resolve=>requestAnimationFrame(resolve));
   const mime=['video/webm;codecs=vp9','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));
   if(!mime)throw new Error('No WebM encoder');
   const recorder=new MediaRecorder(stream,{mimeType:mime});
   const chunks=[];
   const stopped=new Promise((resolve,reject)=>{recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.onstop=resolve;recorder.onerror=reject;});
   recorder.start();
   for(const color of ['#ff0000','#00ff00','#0000ff']){
    ctx.fillStyle=color;ctx.fillRect(0,0,64,64);track.requestFrame();
    await new Promise(resolve=>setTimeout(resolve,100));
   }
   recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());
   const blob=new Blob(chunks,{type:mime});
   const url=URL.createObjectURL(blob),video=document.createElement('video');video.muted=true;
   const loaded=new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(new Error('Encoded WebM could not decode'));});
   video.src=url;await loaded;
   await new Promise(resolve=>{video.requestVideoFrameCallback(resolve);video.play();});video.pause();
   ctx.clearRect(0,0,64,64);ctx.drawImage(video,0,0);
   const first=Array.from(ctx.getImageData(32,32,1,1).data);
   const decoded={width:video.videoWidth,height:video.videoHeight,bytes:blob.size,ended:track.readyState,first};
   video.removeAttribute('src');video.load();URL.revokeObjectURL(url);
   return decoded;
  })()`);
  assert.equal(result.width,64);assert.equal(result.height,64);assert(result.bytes>100);assert.equal(result.ended,'ended');
  assert(result.first[0]>200 && result.first[1]<30 && result.first[3]>240,'First encoded frame must contain the prepared composition');
  console.log('Export capture passed: explicit completed frames encode/decode as WebM and tracks stop.',result);
 } catch(error){console.error(error);process.exitCode=1;} finally {window.destroy();app.quit();}
});
