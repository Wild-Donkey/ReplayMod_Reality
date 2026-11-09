// Decode a saved application export, including its transparent composition.
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
app.whenReady().then(async () => {
  const window = new BrowserWindow({show:false, webPreferences:{backgroundThrottling:false}});
  try {
    const data = fs.readFileSync(process.argv[2]).toString('base64');
    await window.loadURL('data:text/html,<html></html>');
    const result = await window.webContents.executeJavaScript(`(async () => {
      const video = document.createElement('video'); video.muted = true;
      video.src = ${JSON.stringify(`data:video/webm;base64,${data}`)};
      await new Promise((resolve,reject) => {video.onloadeddata=resolve;video.onerror=()=>reject(new Error('Video decode failed'));});
      await new Promise(resolve=>{video.requestVideoFrameCallback(resolve);video.play();});video.pause();
      const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
      const ctx=canvas.getContext('2d');ctx.drawImage(video,0,0);
      const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      let opaque=0,transparent=0;
      for(let i=3;i<rgba.length;i+=4){if(rgba[i]===0)transparent++;else opaque++;}
      const png=canvas.toDataURL('image/png').split(',')[1];
      const width=video.videoWidth,height=video.videoHeight;
      if(!Number.isFinite(video.duration)) {
        await new Promise(resolve=>{video.onseeked=resolve;video.currentTime=1e10;});
      }
      const duration=video.duration;
      video.removeAttribute('src');video.load();
      return {width,height,duration,opaque,transparent,png};
    })()`);
    assert(result.width>0 && result.height>0);
    fs.writeFileSync('/private/tmp/replay-export-frame.png',Buffer.from(result.png,'base64'));
    console.log('Decoded metadata:', {width:result.width,height:result.height,duration:result.duration,opaque:result.opaque,transparent:result.transparent});
    assert(result.opaque>0,'Export is empty');
    assert(result.transparent>0,'Transparent overlay lost alpha');
    assert(Number.isFinite(result.duration) && result.duration>0,'Invalid video duration');
    delete result.png;
    console.log('Application export decoded:',result);
  } catch(error) {console.error(error);process.exitCode=1;} finally {window.destroy();app.quit();}
});
