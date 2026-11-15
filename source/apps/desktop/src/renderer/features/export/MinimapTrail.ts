import {FOOTPRINT_RGB} from "../../render-engine/FootprintColor";
export interface TrailPoint {x: number; y: number; time: number}
export {FOOTPRINT_CSS_COLOR as MINIMAP_TRAJECTORY_COLOR} from "../../render-engine/FootprintColor";
export const MINIMAP_TRAIL_MILLISECONDS = 60_000;

/** Clip each segment to the visible circle before measuring its time range. */
export function visibleTrail(points: readonly TrailPoint[], size: number) {
  const center = size / 2, radius = center;
  const segments: [TrailPoint, TrailPoint][] = [];
  const mix = (a: TrailPoint, b: TrailPoint, t: number): TrailPoint => ({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,time:a.time+(b.time-a.time)*t});
  for (let i=1;i<points.length;i++) {
    const a=points[i-1], b=points[i];
    if (![a.x,a.y,a.time,b.x,b.y,b.time].every(Number.isFinite) || b.time<a.time || b.time-a.time>300_000) continue;
    const dx=b.x-a.x,dy=b.y-a.y,x=a.x-center,y=a.y-center;
    const aa=dx*dx+dy*dy, bb=2*(x*dx+y*dy), cc=x*x+y*y-radius*radius;
    if (aa===0) {if(cc<=0)segments.push([a,b]);continue;}
    const discriminant=bb*bb-4*aa*cc;
    if(discriminant<0)continue;
    const root=Math.sqrt(discriminant);
    const lo=Math.max(0,(-bb-root)/(2*aa)),hi=Math.min(1,(-bb+root)/(2*aa));
    if(hi>lo)segments.push([mix(a,b,lo),mix(a,b,hi)]);
  }
  const oldest=segments.reduce((time,[a])=>Math.min(time,a.time),Infinity);
  const newest=segments.reduce((time,[,b])=>Math.max(time,b.time),-Infinity);
  return {segments,oldest,newest};
}

export function drawMinimapTrail(context: CanvasRenderingContext2D, points: readonly TrailPoint[], size: number) {
  const {segments,oldest,newest}=visibleTrail(points,size);
  const alpha=(time:number)=>newest>oldest?Math.max(0,Math.min(1,(time-oldest)/(newest-oldest))):1;
  context.save();
  context.lineWidth=5;context.lineCap="round";context.lineJoin="round";
  // Short gradients preserve time-based fading even when speed varies.
  for(const [a,b] of segments) {
    if(a.x===b.x&&a.y===b.y)continue;
    const gradient=context.createLinearGradient(a.x,a.y,b.x,b.y);
    gradient.addColorStop(0,`rgba(${FOOTPRINT_RGB.join(",")},${alpha(a.time)})`);
    gradient.addColorStop(1,`rgba(${FOOTPRINT_RGB.join(",")},${alpha(b.time)})`);
    context.strokeStyle=gradient;
    context.beginPath();context.moveTo(a.x,a.y);context.lineTo(b.x,b.y);context.stroke();
  }
  context.restore();
}
