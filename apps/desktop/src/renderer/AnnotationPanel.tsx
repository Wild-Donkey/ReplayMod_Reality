import { useState } from "react";
import type { AnnotationProject, AnnotationNode } from "../../../../packages/data/src";
import { exportKml, parseAnnotationProject } from "./annotations";
interface Props {
  project: AnnotationProject;
  onChange: (project: AnnotationProject) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  status: string;
  ready: boolean;
}
export function AnnotationPanel({project,onChange,selectedId,onSelect,status,ready}: Props) {
  const [error,setError] = useState("");
  const selected=project.nodes.find(n=>n.id===selectedId);
  const update=(patch:Partial<AnnotationNode>)=>onChange({...project,nodes:project.nodes.map(n=>n.id===selectedId?{...n,...patch}:n)});
  const folders=project.nodes.filter(n=>n.kind==="folder");
  const descendants = (id:string) => {
    const result=new Set([id]); let changed=true;
    while(changed){changed=false; for(const n of project.nodes) if(n.parentId && result.has(n.parentId) && !result.has(n.id)){result.add(n.id);changed=true;}}
    return result;
  };
  const importFile=async()=>{
    try{setError("");const file=await window.replaymod?.openAnnotations();if(file){const next=parseAnnotationProject(file.content,file.name);onChange(next);}}
    catch(e){setError(e instanceof Error?e.message:"导入失败");}
  };
  const exportFile=async(format:"json"|"kml")=>{
    try{setError("");await window.replaymod?.exportAnnotations(format==="kml"?exportKml(project):JSON.stringify(project,null,2),format);}
    catch(e){setError(e instanceof Error?e.message:"导出失败");}
  };
  const renderNodes=(parentId:string|null,depth=0):React.ReactNode=>project.nodes.filter(n=>n.parentId===parentId).map(n=>(
    <div key={n.id}>
      <div className={`annotation-row ${n.id===selectedId?"selected":""}`} style={{paddingLeft:depth*12}}>
        <input type="checkbox" aria-label={`显示 ${n.name}`} checked={n.visible} onChange={()=>onChange({...project,nodes:project.nodes.map(node=>node.id===n.id?{...node,visible:!node.visible}:node)})}/>
        {n.kind==="folder" && <button type="button" aria-label={`${n.open?"收起":"展开"} ${n.name}`} onClick={()=>onChange({...project,nodes:project.nodes.map(node=>node.id===n.id?{...node,open:!node.open}:node)})}>{n.open?"▾":"▸"}</button>}
        <button type="button" className="annotation-name" title={n.name} onClick={()=>onSelect(n.id)}>{n.kind==="point"?"● ":n.kind==="route"?"↝ ":""}{n.name}</button>
      </div>
      {n.kind==="folder" && n.open && renderNodes(n.id,depth+1)}
    </div>
  ));
  return <section className="annotation-panel">
    <div className="section-label">我的地图 · {project.nodes.filter(n=>n.kind==="point").length} 点 / {project.nodes.filter(n=>n.kind==="route").length} 线</div>
    <div className="annotation-actions">
      <button type="button" disabled={!ready} onClick={()=>void importFile()}>导入 KML / 项目</button>
      <button type="button" disabled={!ready} onClick={()=>{const id=crypto.randomUUID();onChange({...project,nodes:[...project.nodes,{id,parentId:selected?.kind==="folder"?selected.id:selected?.parentId??null,kind:"folder",name:"新建分组",description:"",visible:true,open:true,coordinates:[],altitudeMode:"clampToGround",style:{color:"#55cfff",opacity:1,width:3}}]});onSelect(id);}}>新建分组</button>
      <button type="button" disabled={!ready} onClick={()=>void exportFile("json")}>导出项目</button>
      <button type="button" disabled={!ready} onClick={()=>void exportFile("kml")}>导出 KML</button>
    </div>
    <small role="status">{status}</small>
    <div className="annotation-tree">{renderNodes(null)}</div>
    {selected && <div className="annotation-editor">
      <label>名称<input value={selected.name} onChange={e=>update({name:e.target.value})}/></label>
      <label>描述<textarea value={selected.description} onChange={e=>update({description:e.target.value})}/></label>
      <label>分组<select value={selected.parentId??""} onChange={e=>update({parentId:e.target.value||null})}><option value="">根目录</option>{folders.filter(f=>!descendants(selected.id).has(f.id)).map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
      {selected.kind!=="folder" && <>
        <label>颜色<input type="color" value={selected.style.color} onChange={e=>update({style:{...selected.style,color:e.target.value}})}/></label>
        <label>线宽<input type="number" min="1" max="20" value={selected.style.width} onChange={e=>{const width=Number(e.target.value);if(width>0&&width<=20)update({style:{...selected.style,width}});}}/></label>
        <span>{selected.coordinates.length.toLocaleString()} 个坐标 · {selected.altitudeMode}</span>
        {selected.kind==="point" && <>
          <label>经度<input type="number" step="any" min="-180" max="180" value={selected.coordinates[0][0]} onChange={e=>{if(!e.target.value)return;const v=Number(e.target.value);if(Number.isFinite(v)&&Math.abs(v)<=180)update({coordinates:[[v,selected.coordinates[0][1],selected.coordinates[0][2]??0]]});}}/></label>
          <label>纬度<input type="number" step="any" min="-90" max="90" value={selected.coordinates[0][1]} onChange={e=>{if(!e.target.value)return;const v=Number(e.target.value);if(Number.isFinite(v)&&Math.abs(v)<=90)update({coordinates:[[selected.coordinates[0][0],v,selected.coordinates[0][2]??0]]});}}/></label>
        </>}
      </>}
      <button type="button" onClick={()=>{const removed=descendants(selected.id);onChange({...project,nodes:project.nodes.filter(n=>!removed.has(n.id))});}}>删除{selected.kind==="folder"?"分组及其内容":"标注"}</button>
    </div>}
    {error && <div className="data-error">{error}</div>}
  </section>;
}
