import type {OrientationSample} from "./types";
import type {AlignmentPoint} from "./motion-alignment";
export interface MotionPoint extends AlignmentPoint {altitude?:number}
export interface MotionGpsResult {videoStartSeconds:number;points:MotionPoint[];correctedPoints:number;curvedIntervals:number;reason:string}
const wrap=(x:number)=>Math.atan2(Math.sin(x),Math.cos(x));
const R=6371000,rad=Math.PI/180;

/** GPS remains the position anchor; camera yaw only shapes short, supported intervals. */
export function processMotionGps(samples:readonly OrientationSample[],input:readonly MotionPoint[],videoStart:number):MotionGpsResult {
 const gps=input.filter(p=>[p.timeSeconds,p.longitude,p.latitude].every(Number.isFinite)&&Math.abs(p.longitude)<=180&&Math.abs(p.latitude)<=90).map(p=>({...p})).sort((a,b)=>a.timeSeconds-b.timeSeconds).filter((p,i,a)=>!i||p.timeSeconds>a[i-1].timeSeconds);
 const imu=samples.flatMap(s=>{
  const n=Math.hypot(...s.quaternion);if(!Number.isFinite(s.timeSeconds)||!Number.isFinite(n)||n<1e-8)return [];
  const [w,x,y,z]=s.quaternion.map(v=>v/n);
  return [{t:s.timeSeconds+videoStart,yaw:Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z))}];
 }).sort((a,b)=>a.t-b.t);
 const xy=(a:MotionPoint,b:MotionPoint)=>[wrap((b.longitude-a.longitude)*rad)*R*Math.cos(a.latitude*rad),(b.latitude-a.latitude)*rad*R];
 const original=gps.map(p=>({...p}));
 let correctedPoints=0,curvedIntervals=0;
 // Repair only isolated, physically implausible spikes, never smooth all GPS anchors.
 for(let i=1;i<gps.length-1;i++){
  const a=original[i-1],b=original[i],c=original[i+1];
  const dt=b.timeSeconds-a.timeSeconds,du=c.timeSeconds-b.timeSeconds;
  if(dt<=0||du<=0||dt>10||du>10)continue;
  const ab=xy(a,b),bc=xy(b,c),ac=xy(a,c),d1=Math.hypot(...ab),d2=Math.hypot(...bc),d=Math.hypot(...ac);
  if(d1/dt>100&&d2/du>100&&d/(dt+du)<50&&d1+d2>Math.max(100,d*4)){
   const t=dt/(dt+du);gps[i]={...b,longitude:a.longitude+wrap((c.longitude-a.longitude)*rad)/rad*t,latitude:a.latitude+(c.latitude-a.latitude)*t};correctedPoints++;
  }
 }
 const yaw=(t:number)=>{
  let lo=0,hi=imu.length;while(lo<hi){const m=(lo+hi)>>>1;if(imu[m].t<t)lo=m+1;else hi=m;}
  const a=imu[lo-1],b=imu[lo];if(!a||!b||b.t-a.t>.25)return null;
  return a.yaw+wrap(b.yaw-a.yaw)*(t-a.t)/(b.t-a.t);
 };
 // Establish camera-axis handedness from multiple GPS turns. Free camera motion falls back to GPS-only interpolation.
 const courses=gps.slice(1).flatMap((b,i)=>{const a=gps[i],d=xy(a,b),dt=b.timeSeconds-a.timeSeconds,y=yaw((a.timeSeconds+b.timeSeconds)/2);return dt>0&&dt<=10&&Math.hypot(...d)>5&&y!==null?[{t:(a.timeSeconds+b.timeSeconds)/2,h:Math.atan2(d[0],d[1]),y}]:[];});
 let energy=0,errorPlus=0,errorMinus=0;
 for(let i=1;i<courses.length;i++){const a=courses[i-1],b=courses[i];if(b.t-a.t>15)continue;const dh=wrap(b.h-a.h),dy=wrap(b.y-a.y);energy+=dh*dh;errorPlus+=wrap(dh-dy)**2;errorMinus+=wrap(dh+dy)**2;}
 const sign=errorPlus<=errorMinus?1:-1;
 const reliable=courses.length>=5&&energy>.03&&Math.min(errorPlus,errorMinus)<energy*.35;
 const points:MotionPoint[]=[];
 for(let i=0;i<gps.length;i++){
  const a=gps[i];points.push(a);const b=gps[i+1];if(!b)continue;
  const dt=b.timeSeconds-a.timeSeconds;if(dt<=.1||dt>10||Math.abs(a.latitude)>89)continue; // Never bridge GPS outages.
  const delta=xy(a,b),distance=Math.hypot(...delta),steps=Math.ceil(dt*10);
  if(points.length+steps>500000)throw new Error("轨迹处理范围过大，请缩短视频片段。");
  let curved=false;let path:number[][]=[];
  if(reliable&&distance/dt>1&&distance/dt<70){
   const angles=Array.from({length:steps},(_,j)=>yaw(a.timeSeconds+(j+.5)*dt/steps));
   if(angles.every(v=>v!==null)){
    const ys=angles as number[],mean=Math.atan2(ys.reduce((n,y)=>n+Math.sin(sign*y),0),ys.reduce((n,y)=>n+Math.cos(sign*y),0)),course=Math.atan2(delta[0],delta[1]);
    let x=0,y=0;path=[[0,0]];
    for(const angle of ys){const h=course+wrap(sign*angle-mean);x+=Math.sin(h)*distance/steps;y+=Math.cos(h)*distance/steps;path.push([x,y]);}
    const ex=delta[0]-x,ey=delta[1]-y;
    if(Math.hypot(ex,ey)<distance*.2&&ys.every(v=>Math.abs(wrap(sign*v-mean))<Math.PI/3)){
     path=path.map(([px,py],j)=>[px+ex*j/steps,py+ey*j/steps]);curved=true;curvedIntervals++;
    }
   }
  }
  for(let j=1;j<steps;j++){
   const t=j/steps,[x,y]=curved?path[j]:[delta[0]*t,delta[1]*t];
   points.push({timeSeconds:a.timeSeconds+dt*t,longitude:a.longitude+x/(R*Math.cos(a.latitude*rad))/rad,latitude:a.latitude+y/R/rad,
    ...(Number.isFinite(a.altitude)&&Number.isFinite(b.altitude)?{altitude:a.altitude!+(b.altitude!-a.altitude!)*t}:{})});
  }
 }
 return {videoStartSeconds:videoStart,points,correctedPoints,curvedIntervals,reason:reliable?"已用 GPS 锚点约束姿态辅助插值；不可靠区间回退为 GPS 线性插值。":"相机运动与 GPS 转向关联不足，保留 GPS 锚点并使用线性插值。"};
}
