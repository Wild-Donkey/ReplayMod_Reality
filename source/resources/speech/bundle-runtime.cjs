// Build-time only: bundle the interpreter and libraries, never model files.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const runtime=path.resolve(process.argv[2]||path.resolve(__dirname,'../../../.tools/qwen'));
const target=path.resolve(process.argv[3]||path.resolve(__dirname,'../../../.tools/speech-runtime'));
const venvPython=path.join(runtime,'venv/bin/python');
if(!fs.existsSync(venvPython))throw Error('Missing speech runtime. Run npm run setup:speech before packaging.');
const interpreter=fs.realpathSync(venvPython),pythonRoot=path.dirname(path.dirname(interpreter));
fs.rmSync(target,{recursive:true,force:true});fs.mkdirSync(target,{recursive:true});
const options={recursive:true,verbatimSymlinks:true,filter:file=>!file.endsWith('.pyc')&&path.basename(file)!=='__pycache__'};
fs.cpSync(pythonRoot,path.join(target,'python'),options);
fs.cpSync(path.join(runtime,'venv/lib/python3.11/site-packages'),path.join(target,'site-packages'),options);
// The bundled interpreter uses its own relative stdlib and the bundled site-packages.
execFileSync(path.join(target,'python/bin/python3.11'),['-c','import mlx.core, mlx_audio.stt, soundfile; print("Bundled speech runtime verified; no models included.")'],{env:{...process.env,PYTHONPATH:path.join(target,'site-packages'),HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'},stdio:'inherit'});
