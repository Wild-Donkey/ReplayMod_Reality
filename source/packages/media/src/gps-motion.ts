import type {OrientationSample} from "./types";
import type {AlignmentPoint} from "./motion-alignment";
export interface MotionPoint extends AlignmentPoint {altitude?:number}
export interface MotionGpsResult {
 videoStartSeconds:number;videoEndSeconds:number;points:MotionPoint[];contextPoints:MotionPoint[];
 fittedWindows?:number;attitudeConstraints?:number;correctedPoints:number;curvedIntervals:number;smoothedIntervals:number;bridgedIntervals:number;reason:string;
}
const wrap=(x:number)=>Math.atan2(Math.sin(x),Math.cos(x));
const R=6371000,rad=Math.PI/180;
// Covers the display speed filter's 3 s support and grid interpolation.
const ANALYSIS_MARGIN_SECONDS = 4;

function tangent(before: number, after: number, beforeSeconds: number, afterSeconds: number) {
 if (before * after <= 0) return 0;
 const leftWeight = 2 * afterSeconds + beforeSeconds;
 const rightWeight = afterSeconds + 2 * beforeSeconds;
 return (leftWeight + rightWeight) / (leftWeight / before + rightWeight / after);
}

function smoothCoordinate(delta: number, startTangent: number, endTangent: number, t: number) {
 return ((startTangent + endTangent - 2 * delta) * t + 3 * delta - 2 * startTangent - endTangent) * t * t + startTangent * t;
}

/** GPS remains the position anchor; camera yaw only shapes short, supported intervals. */
export function processMotionGps(samples:readonly OrientationSample[],input:readonly MotionPoint[],videoStart:number,videoEnd=Infinity):MotionGpsResult {
 const gps=input.filter(p=>[p.timeSeconds,p.longitude,p.latitude].every(Number.isFinite)&&Math.abs(p.longitude)<=180&&Math.abs(p.latitude)<=90).map(p=>({...p})).sort((a,b)=>a.timeSeconds-b.timeSeconds).filter((p,i,a)=>!i||p.timeSeconds>a[i-1].timeSeconds);
 const imu=samples.flatMap(s=>{
  const n=Math.hypot(...s.quaternion);if(!Number.isFinite(s.timeSeconds)||!Number.isFinite(n)||n<1e-8)return [];
  const [w,x,y,z]=s.quaternion.map(v=>v/n);
  return [{t:s.timeSeconds+videoStart,yaw:Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z))}];
 }).sort((a,b)=>a.t-b.t);
 const xy=(a:MotionPoint,b:MotionPoint)=>[wrap((b.longitude-a.longitude)*rad)*R*Math.cos(a.latitude*rad),(b.latitude-a.latitude)*rad*R];
 const original=gps.map(p=>({...p}));
 let correctedPoints=0,curvedIntervals=0,smoothedIntervals=0,bridgedIntervals=0;
 const bounded = Number.isFinite(videoEnd);
 const analysisStart = bounded ? videoStart - ANALYSIS_MARGIN_SECONDS : -Infinity;
 const analysisEnd = bounded ? videoEnd + ANALYSIS_MARGIN_SECONDS : Infinity;
 // Repair only isolated, physically implausible spikes, never smooth all GPS anchors.
 for(let i=1;i<gps.length-1;i++){
  const a=original[i-1],b=original[i],c=original[i+1];
  const dt=b.timeSeconds-a.timeSeconds,du=c.timeSeconds-b.timeSeconds;
  if(dt<=0||du<=0||dt>10||du>10)continue;
  const ab=xy(a,b),bc=xy(b,c),ac=xy(a,c),d1=Math.hypot(...ab),d2=Math.hypot(...bc),d=Math.hypot(...ac);
  if(d1/dt>100&&d2/du>100&&d/(dt+du)<50&&d1+d2>Math.max(100,d*4)){
   const t=dt/(dt+du);gps[i]={...b,longitude:wrap(a.longitude*rad+wrap((c.longitude-a.longitude)*rad)*t)/rad,latitude:a.latitude+(c.latitude-a.latitude)*t};
   if(b.timeSeconds>=videoStart&&b.timeSeconds<=videoEnd)correctedPoints++;
  }
 }
 const yaw=(t:number)=>{
  let lo=0,hi=imu.length;while(lo<hi){const m=(lo+hi)>>>1;if(imu[m].t<t)lo=m+1;else hi=m;}
  const a=imu[lo-1],b=imu[lo];if(!a||!b||b.t-a.t>.25)return null;
  return a.yaw+wrap(b.yaw-a.yaw)*(t-a.t)/(b.t-a.t);
 };
 // Establish camera-axis handedness from multiple GPS turns. Free camera motion falls back to GPS-only interpolation.
 const courses=gps.slice(1).flatMap((b,i)=>{const a=gps[i],d=xy(a,b),dt=b.timeSeconds-a.timeSeconds,y=yaw((a.timeSeconds+b.timeSeconds)/2);return dt>0&&dt<=10&&Math.hypot(...d)>5&&y!==null?[{t:(a.timeSeconds+b.timeSeconds)/2,h:Math.atan2(d[0],d[1]),y}]:[];});
 const turns=courses.slice(1).flatMap((b,i)=>{
  const a=courses[i];
  return b.t-a.t<=15?[{start:a.t,end:b.t,course:wrap(b.h-a.h),camera:wrap(b.y-a.y)}]:[];
 });
 const attitudeSign=(start:number,end:number)=>{
  let count=0,energy=0,errorPlus=0,errorMinus=0;
  let low=0,high=turns.length;
  while(low<high){const middle=(low+high)>>>1;if(turns[middle].end<start-12)low=middle+1;else high=middle;}
  for(let index=low;index<turns.length&&turns[index].start<=end+12;index++){
   const turn=turns[index];
   count++;energy+=turn.course**2;errorPlus+=wrap(turn.course-turn.camera)**2;errorMinus+=wrap(turn.course+turn.camera)**2;
  }
  if(count<3||energy<=.03||Math.min(errorPlus,errorMinus)>=energy*.35)return 0;
  return errorPlus<=errorMinus?1:-1;
 };
 // Shape-preserving Hermite tangents share velocities across consecutive GPS fixes.
 // A stop or a reversal gets zero tangent on the affected coordinate.
 const velocities=gps.slice(1).map((b,i)=>{
  const a=gps[i],dt=b.timeSeconds-a.timeSeconds;
  return dt>0&&(dt<=10||bounded)?{dt,lon:wrap((b.longitude-a.longitude)*rad)/dt,lat:(b.latitude-a.latitude)*rad/dt}:null;
 });
 const slopes=gps.map((_,i)=>{
  const before=velocities[i-1],after=velocities[i];
  return before&&after?{lon:tangent(before.lon,after.lon,before.dt,after.dt),lat:tangent(before.lat,after.lat,before.dt,after.dt)}:before??after;
 });
 const points:MotionPoint[]=[];
 for(let i=0;i<gps.length;i++){
  const a=gps[i];points.push(a);const b=gps[i+1];if(!b)continue;
  const dt=b.timeSeconds-a.timeSeconds,longGap=dt>10;
  if(dt<=0||(longGap&&!bounded)||Math.abs(a.latitude)>=90)continue;
  // Fit against all available anchors; limit only the samples materialized for
  // playback, using a grid anchored to the GPS interval rather than the clip.
  const from=Math.max(analysisStart,a.timeSeconds);
  const to=Math.min(analysisEnd,b.timeSeconds);
  if(to<=from)continue;
  const delta=xy(a,b),distance=Math.hypot(...delta),steps=Math.ceil(dt*10);
  const firstStep=Math.max(1,Math.ceil((from-a.timeSeconds)/dt*steps));
  const lastStep=Math.min(steps-1,Math.floor((to-a.timeSeconds)/dt*steps));
  const sign=!longGap&&imu.length ? attitudeSign(a.timeSeconds,b.timeSeconds) : 0;
  const overlapsVideo=a.timeSeconds<videoEnd&&b.timeSeconds>videoStart;
  if(points.length+Math.max(0,lastStep-firstStep+1)+6>500000)throw new Error("轨迹处理范围过大，请缩短视频片段。");
  let curved=false;let path:number[][]=[];
  if(sign&&distance/dt>1&&distance/dt<70){
   const angles=Array.from({length:steps},(_,j)=>yaw(a.timeSeconds+(j+.5)*dt/steps));
   if(angles.every(v=>v!==null)){
    const ys=angles as number[],mean=Math.atan2(ys.reduce((n,y)=>n+Math.sin(sign*y),0),ys.reduce((n,y)=>n+Math.cos(sign*y),0)),course=Math.atan2(delta[0],delta[1]);
    let x=0,y=0;path=[[0,0]];
    for(const angle of ys){const h=course+wrap(sign*angle-mean);x+=Math.sin(h)*distance/steps;y+=Math.cos(h)*distance/steps;path.push([x,y]);}
    const ex=delta[0]-x,ey=delta[1]-y;
    if(Math.hypot(ex,ey)<distance*.2&&ys.every(v=>Math.abs(wrap(sign*v-mean))<Math.PI/3)){
     path=path.map(([px,py],j)=>[px+ex*j/steps,py+ey*j/steps]);
     curved=path.some(([px,py],j)=>Math.hypot(px-delta[0]*j/steps,py-delta[1]*j/steps)>.12);
    }
   }
  }
  const metersPerLonRadian=R*Math.cos(a.latitude*rad);
  const startSlope=slopes[i]!,endSlope=slopes[i+1]!;
  const eastStart=startSlope.lon*dt*metersPerLonRadian,eastEnd=endSlope.lon*dt*metersPerLonRadian;
  const northStart=startSlope.lat*dt*R,northEnd=endSlope.lat*dt*R;
  if(overlapsVideo){
   if(longGap)bridgedIntervals++;
   if(curved)curvedIntervals++;
   else if(Math.max(Math.hypot(eastStart-delta[0],northStart-delta[1]),Math.hypot(eastEnd-delta[0],northEnd-delta[1]))>.01)smoothedIntervals++;
  }
  const times = new Set([from, to]);
  for(let j=firstStep;j<=lastStep;j++) times.add(a.timeSeconds+dt*j/steps);
  for(const edge of [videoStart,videoEnd]) if(edge>from&&edge<to)times.add(edge);
  for(const time of [...times].sort((left,right)=>left-right)){
   if(time<=a.timeSeconds||time>=b.timeSeconds||time<from||time>to)continue;
   const t=(time-a.timeSeconds)/dt;
   let x: number, y: number;
   if(curved){
    const k=Math.min(steps-1,Math.floor(t*steps)),ratio=t*steps-k;
    x=path[k][0]+(path[k+1][0]-path[k][0])*ratio;
    y=path[k][1]+(path[k+1][1]-path[k][1])*ratio;
   } else {
    x=smoothCoordinate(delta[0],eastStart,eastEnd,t);
    y=smoothCoordinate(delta[1],northStart,northEnd,t);
   }
   points.push({timeSeconds:time,longitude:wrap(a.longitude*rad+x/metersPerLonRadian)/rad,latitude:a.latitude+y/R/rad,
    ...(Number.isFinite(a.altitude)&&Number.isFinite(b.altitude)?{altitude:a.altitude!+(b.altitude!-a.altitude!)*t}:{})});
  }
 }
 const reason=curvedIntervals ? "只在姿态和 GPS 转向吻合的区间使用姿态。"
  : imu.length ? "没有通过姿态匹配的区间。" : "未读取到姿态样本。";
 const visiblePoints=bounded?points.filter(p=>p.timeSeconds>=videoStart&&p.timeSeconds<=videoEnd):points;
 const contextPoints=bounded?points.filter(p=>p.timeSeconds>=analysisStart&&p.timeSeconds<=analysisEnd&&
  (p.timeSeconds<videoStart||p.timeSeconds>videoEnd)):[];
 return {videoStartSeconds:videoStart,videoEndSeconds:videoEnd,points:visiblePoints,contextPoints,correctedPoints,curvedIntervals,smoothedIntervals,bridgedIntervals,reason};
}
