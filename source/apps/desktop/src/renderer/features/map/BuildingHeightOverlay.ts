import maplibregl, {type Map as GLMap, type StyleSpecification, type ExpressionSpecification, type GeoJSONSource} from "maplibre-gl";
import type {Feature, FeatureCollection, Geometry} from "geojson";
import {cachedMapRequest} from "../../shared/cache";
import {buildingOpacity} from "./basemapStyle";

// Some providers expose the footprint at every LOD but only attach an exact
// height to a subset of buildings. Treating a missing height as zero makes
// whole neighbourhoods blink out at tile/LOD boundaries. Prefer the measured
// height, then infer it from floor count, and finally retain the footprint as
// a conservative one-storey (3 m) building.
const height: ExpressionSpecification = ["max",3,["to-number",["coalesce",
  ["get","height"],["get","render_height"],
  ["*",3,["to-number",["coalesce",["get","levels"],["get","building:levels"],1]]],
  3,
]]];
const decimetres: ExpressionSpecification = ["round",["*",["min",6553.5,height],10]];
const high: ExpressionSpecification = ["floor",["/",decimetres,256]];
const low: ExpressionSpecification = ["-",decimetres,["*",high,256]];
const MEMORY_SOURCE="building-height-memory";
const MEMORY_LAYER="building-height-memory-buffer";
const BASE_MEMORY_SOURCE="elevation-buildings-memory-source";
const BASE_MEMORY_LAYER="elevation-buildings-memory";
const PROVIDER_LAYER="building-height-buffer";
const PROVIDER_MIN_ZOOM=13;
const MEMORY_MIN_ZOOM=7;

const buildingPaint = {"fill-color":["rgba",high,low,0,1] as ExpressionSpecification,"fill-opacity":1,"fill-antialias":false} as const;

// Hidden MapLibre pass: R/G store an unsigned 16-bit building height in
// decimetres. Geometry remains vector until this screen-resolution pass.
export class BuildingHeightOverlay {
  readonly container=document.createElement("div");
  readonly map: GLMap;
  get canvas() { return this.map.getCanvas(); }
  private disposed=false;
  private providerSource: string | null=null;
  private providerMinZoom=PROVIDER_MIN_ZOOM;
  private remembered=new Map<string,Feature<Geometry,Record<string,unknown>>>();
  private rememberedBytes=new Map<string,number>();
  private memoryBytes=0;
  private memoryRevision=0;
  private publishedRevision=-1;
  private sync=()=>this.synchronize();
  private capture=()=>{
    this.captureVisibleBuildings();
    // The hidden map clears its framebuffer while swapping vector-tile LODs.
    // Only expose a new frame after MapLibre reports that the replacement LOD
    // is idle; the terrain renderer keeps the previous valid texture meanwhile.
    this.canvas.dataset.buildingFrameReady="1";
    this.base.triggerRepaint();
  };
  private captureBeforeMove=()=>{
    this.captureVisibleBuildings();
    this.canvas.dataset.buildingFrameReady="0";
  };
  private captureLoadedSource=(event:{sourceId?:string})=>{
    // Capture incrementally as each vector tile arrives. Waiting for the whole
    // source to become idle loses the useful high-detail tiles when the user
    // crosses a zoom boundary quickly.
    if(event.sourceId===this.providerSource)this.captureVisibleBuildings();
  };
  constructor(private base:GLMap,style:StyleSpecification,private memoryLimitMB=256) {
    Object.assign(this.container.style,{position:"absolute",inset:"0",pointerEvents:"none",opacity:"0"});
    base.getCanvasContainer().before(this.container);
    const center=base.getCenter();
    this.map=new maplibregl.Map({container:this.container,style,center:[center.lng,center.lat],zoom:base.getZoom(),bearing:base.getBearing(),pitch:base.getPitch(),interactive:false,attributionControl:false,transformRequest:cachedMapRequest,canvasContextAttributes:{alpha:true,preserveDrawingBuffer:true}});
    this.canvas.dataset.buildingFrameReady="0";
    if(!base.getSource(BASE_MEMORY_SOURCE))base.addSource(BASE_MEMORY_SOURCE,{type:"geojson",data:{type:"FeatureCollection",features:[]}});
    if(!base.getLayer(BASE_MEMORY_LAYER)){
      const firstSymbol=(base.getStyle().layers??[]).find(layer=>layer.type==="symbol")?.id;
      base.addLayer({id:BASE_MEMORY_LAYER,type:"fill",source:BASE_MEMORY_SOURCE,minzoom:MEMORY_MIN_ZOOM,layout:{"fill-sort-key":height},paint:{"fill-color":"#ffffff","fill-opacity":buildingOpacity,"fill-antialias":false}},firstSymbol);
    }
    this.map.once("load",()=>{
      const layers=this.map.getStyle().layers??[];
      const template=layers.find(layer=>"source-layer" in layer&&layer["source-layer"]==="building"&&"source" in layer&&typeof layer.source==="string");
      for(const layer of layers)this.map.setLayoutProperty(layer.id,"visibility","none");
      this.map.addSource(MEMORY_SOURCE,{type:"geojson",data:{type:"FeatureCollection",features:[]}});
      // Never hard-switch the remembered coarse LOD off. It remains a stable
      // underlay at every zoom; provider tiles only add newly available detail
      // above it. Because both encode absolute height opaquely, overlap does
      // not accumulate brightness or alter the stored height value.
      this.map.addLayer({id:MEMORY_LAYER,type:"fill",source:MEMORY_SOURCE,minzoom:MEMORY_MIN_ZOOM,layout:{"fill-sort-key":height},paint:buildingPaint});
      if(template&&"source" in template&&typeof template.source==="string"){
        this.providerSource=template.source;
        this.providerMinZoom=Math.max(PROVIDER_MIN_ZOOM,template.minzoom??PROVIDER_MIN_ZOOM);
        this.map.addLayer({id:PROVIDER_LAYER,type:"fill",source:template.source,"source-layer":"building",minzoom:this.providerMinZoom,layout:{"fill-sort-key":height},paint:buildingPaint});
      }
      this.synchronize();
      this.captureVisibleBuildings();
    });
    this.map.on("render",()=>base.triggerRepaint());
    // querySourceFeatures returns the detailed vector buildings from loaded
    // provider tiles. Retaining them in a GeoJSON source lets geojson-vt build
    // coarser tiles for every area the user has already inspected.
    this.map.on("idle",this.capture);
    // Sample the source that actually produced the user's visible frame.  The
    // old hidden-map listener could be one LOD behind the primary map, so a
    // footprint could be visible on screen yet never enter the coarse cache.
    base.on("sourcedata",this.captureLoadedSource);
    // Capture synchronously before the overlay camera leaves the detailed
    // zoom. Waiting for idle loses the just-visible provider buildings when
    // users zoom continuously.
    base.on("movestart",this.captureBeforeMove);
    base.on("move",this.sync);base.on("resize",this.sync);
  }
  private captureVisibleBuildings(){
    if(this.disposed||!this.providerSource)return;
    // Render queries contain only the subset that survived the current frame's
    // visibility/collision/culling work. At some provider LODs that can be just
    // a few dozen buildings even though the loaded vector tiles contain whole
    // neighbourhoods. Retain both: source features give us complete tiles,
    // while rendered features cover edge cases during an in-flight tile swap.
    const sourceFeatures=this.base.querySourceFeatures(this.providerSource,{sourceLayer:"building"});
    const renderedFeatures=this.base.getLayer("elevation-buildings")
      ? this.base.queryRenderedFeatures(undefined,{layers:["elevation-buildings"]})
      : [];
    const features=[...sourceFeatures,...renderedFeatures];
    for(const feature of features){
      if(!feature.geometry||!(feature.geometry.type==="Polygon"||feature.geometry.type==="MultiPolygon"))continue;
      const properties={...(feature.properties as Record<string,unknown>)};
      const geometry=structuredClone(feature.geometry) as Geometry;
      const geometryJSON=JSON.stringify(geometry);
      // Vector-tile feature ids are commonly only unique inside one tile.
      // Geometry must participate in the key or unrelated buildings from
      // neighbouring tiles collapse into the same remembered feature.
      const key=`${String(feature.id??"")}:${properties.height??properties.render_height??0}:${geometryJSON}`;
      if(this.remembered.has(key))continue;
      const retained={type:"Feature",id:feature.id,properties,geometry} as Feature<Geometry,Record<string,unknown>>;
      const bytes=new TextEncoder().encode(JSON.stringify(retained)).byteLength;
      this.remembered.set(key,retained);this.rememberedBytes.set(key,bytes);this.memoryBytes+=bytes;
      this.memoryRevision++;
      this.trimToLimit();
    }
    this.publishMemory();
  }
  updateMemoryLimit(limitMB:number){
    if(this.disposed)return;
    this.memoryLimitMB=limitMB;
    this.trimToLimit();
    this.publishMemory();
  }
  private trimToLimit(){
    const limit=this.memoryLimitMB*1024*1024;
    while(this.memoryBytes>limit&&this.remembered.size){
      const oldest=this.remembered.keys().next().value!;
      this.memoryBytes-=this.rememberedBytes.get(oldest)??0;
      this.remembered.delete(oldest);this.rememberedBytes.delete(oldest);this.memoryRevision++;
    }
  }
  private publishMemory(){
    if(this.memoryRevision===this.publishedRevision)return;
    this.publishedRevision=this.memoryRevision;
    const collection:FeatureCollection<Geometry,Record<string,unknown>>={type:"FeatureCollection",features:[...this.remembered.values()]};
    (this.map.getSource(MEMORY_SOURCE) as GeoJSONSource|undefined)?.setData(collection);
    (this.base.getSource(BASE_MEMORY_SOURCE) as GeoJSONSource|undefined)?.setData(collection);
    window.dispatchEvent(new CustomEvent("building-cache-stats",{detail:{bytes:this.memoryBytes,features:this.remembered.size}}));
  }
  private synchronize(){if(this.disposed)return;const c=this.base.getCenter();this.map.jumpTo({center:[c.lng,c.lat],zoom:this.base.getZoom(),bearing:this.base.getBearing(),pitch:this.base.getPitch()});this.map.resize();}
  dispose(){if(this.disposed)return;this.disposed=true;this.base.off("movestart",this.captureBeforeMove);this.base.off("move",this.sync);this.base.off("resize",this.sync);this.base.off("sourcedata",this.captureLoadedSource);this.map.off("idle",this.capture);if(this.base.getLayer(BASE_MEMORY_LAYER))this.base.removeLayer(BASE_MEMORY_LAYER);if(this.base.getSource(BASE_MEMORY_SOURCE))this.base.removeSource(BASE_MEMORY_SOURCE);this.map.remove();this.container.remove();this.remembered.clear();this.rememberedBytes.clear();this.memoryBytes=0;window.dispatchEvent(new CustomEvent("building-cache-stats",{detail:{bytes:0,features:0}}));}
}
