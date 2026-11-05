import { useEffect, useRef } from "react";
import { requestGPUDevice, type GPU } from "../../shared/gpu";
import { mappedTerrainLuminance, type TerrainAppearance, type TerrainRange } from "./terrainExposure";
import { toneShader } from "./terrainShaders";

function gradient(range: TerrainRange, appearance: TerrainAppearance, ocean: boolean) {
  const stops = Array.from({length:33},(_,i) => {
    const height = (ocean?-1:1)*(range[0]+(range[1]-range[0])*i/32);
    const linear = mappedTerrainLuminance(height,ocean?(appearance.oceanBlack ?? appearance.black):appearance.black,ocean?(appearance.oceanWhite ?? appearance.white):appearance.white,appearance.headroom,ocean);
    const srgb = linear<=.0031308 ? 12.92*linear : 1.055*linear**(1/2.4)-.055;
    const gray = Math.round(Math.min(1,srgb)*255);
    return `rgb(${gray},${gray},${gray}) ${i/32*100}%`;
  });
  return `linear-gradient(to right,${stops.join(",")})`;
}
function Gradient({range,appearance,ocean}: {range:TerrainRange;appearance:TerrainAppearance;ocean:boolean}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const latest = useRef({range,appearance,ocean}); latest.current = {range,appearance,ocean};
  const renderer = useRef<(() => void) | null>(null);
  useEffect(() => {
    const canvas=ref.current!;
    let disposed=false,texture:GPU,buildingTexture:GPU,settings:GPU,context:GPU,device:GPU;
    const fallback=()=>{canvas.style.visibility="hidden";};
    void requestGPUDevice().then(async gpu => {
      if(disposed)return; device=gpu;
      context=(canvas as GPU).getContext("webgpu");if(!context)return;
      const module=device.createShaderModule({code:toneShader});
      const pipeline=await device.createRenderPipelineAsync({layout:"auto",vertex:{module,entryPoint:"vertex"},fragment:{module,entryPoint:"fragment",targets:[{format:"rgba16float"}]},primitive:{topology:"triangle-list"}});
      if(disposed)return;
      canvas.width=256;canvas.height=1;
      texture=device.createTexture({size:[256,1],format:"rg32float",usage:6});
      // The shared tone shader also accepts the vector-building height
      // buffer. Legends intentionally show terrain only, so bind a zero
      // texture instead of leaving the shader's third binding invalid.
      buildingTexture=device.createTexture({size:[1,1],format:"rgba8unorm",usage:6});
      device.queue.writeTexture({texture:buildingTexture},new Uint8Array(256),{bytesPerRow:256},[1,1]);
      settings=device.createBuffer({size:32,usage:0x48});
      const binding=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:texture.createView()},
        {binding:1,resource:{buffer:settings}},
        {binding:2,resource:buildingTexture.createView()},
      ]});
      renderer.current=()=>{
        if(disposed)return;
        try {
          const {range,appearance,ocean}=latest.current;
          const heights=new Float32Array(512);
          for(let i=0;i<256;i++){heights[i*2]=(ocean?-1:1)*(range[0]+(range[1]-range[0])*i/255);heights[i*2+1]=Number(ocean);}
          device.queue.writeTexture({texture},heights,{bytesPerRow:2048},[256,1]);
          device.queue.writeBuffer(settings,0,new Float32Array([appearance.black,appearance.headroom,appearance.white,0,appearance.oceanBlack ?? appearance.black,appearance.headroom,appearance.oceanWhite ?? appearance.white,0]));
          context.configure({device,format:"rgba16float",alphaMode:"opaque",toneMapping:{mode:appearance.headroom>1?"extended":"standard"}});
          const encoder=device.createCommandEncoder();const pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),loadOp:"clear",storeOp:"store",clearValue:[0,0,0,1]}]});
          pass.setPipeline(pipeline);pass.setBindGroup(0,binding);pass.draw(3);pass.end();device.queue.submit([encoder.finish()]);canvas.style.visibility="visible";
        } catch {fallback();}
      };
      device.addEventListener("uncapturederror",fallback);
      renderer.current();
    }).catch(fallback);
    return()=>{disposed=true;renderer.current=null;device?.removeEventListener("uncapturederror",fallback);texture?.destroy();buildingTexture?.destroy();settings?.destroy();context?.unconfigure();};
  },[]);
  useEffect(()=>{renderer.current?.();},[range,appearance,ocean]);
  return <div className="elevation-gradient" style={{position:"relative",backgroundImage:gradient(range,appearance,ocean)}}>
    <canvas ref={ref} aria-hidden="true" style={{position:"absolute",inset:0,width:"100%",height:"100%",visibility:"hidden"}}/>
  </div>;
}
export function TerrainLegend({appearance}: {appearance:TerrainAppearance|null}) {
  return <div className="elevation-legend" aria-label="当前视野海拔与海深图例">
    {[false,true].map(ocean=>{
      const range=appearance ? (ocean?appearance.depth:appearance.land) : null;
      const title=ocean?"海深":"海拔";
      const format=(value:number)=>value.toLocaleString("zh-CN",{maximumFractionDigits:range&&range[1]-range[0]<10?1:0});
      return <div key={title} className="elevation-legend-row">
        <span>{title}</span>
        {range&&appearance?<div className="elevation-scale" title={`当前视野 ${title} ${format(range[0])}–${format(range[1])} 米；颜色跟随当前明暗映射`}>
          <Gradient range={range} appearance={appearance} ocean={ocean}/>
          <div className="elevation-ticks">{range[1]-range[0]<.1?<span>{format(range[0])} m</span>:<><span>{format(range[0])}</span><span>{format((range[0]+range[1])/2)}</span><span>{format(range[1])} m</span></>}</div>
        </div>:<span className="elevation-range-empty">{appearance?`当前视野无${ocean?"水域":"陆地"}`:"范围读取中…"}</span>}
      </div>;
    })}
  </div>;
}
