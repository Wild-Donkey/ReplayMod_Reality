import type { OrientationSample } from "./types";

export interface AlignmentPoint { timeSeconds: number; longitude: number; latitude: number }
export interface MotionAlignmentResult {
  offsetSeconds: number;
  adjustmentSeconds: number;
  refined: boolean;
  reason: string;
}
const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));

/** Local search only: a user's estimate is authoritative outside this ±3 s window. */
export function refineMotionAlignment(samples: readonly OrientationSample[], points: readonly AlignmentPoint[], estimate: number): MotionAlignmentResult {
  const manual = (reason: string): MotionAlignmentResult => ({ offsetSeconds: estimate, adjustmentSeconds: 0, refined: false, reason });
  if (!Number.isFinite(estimate)) throw new Error("偏移秒数无效。");
  const imu = samples.filter(s => Number.isFinite(s.timeSeconds) && s.quaternion.every(Number.isFinite))
    .map(s => {
      const norm = Math.hypot(...s.quaternion);
      if (norm < 1e-8) return null;
      const [w,x,y,z] = s.quaternion.map(v => v / norm);
      return { t: s.timeSeconds, yaw: Math.atan2(2*(w*z+x*y), 1-2*(y*y+z*z)) };
    }).filter((s): s is {t:number;yaw:number} => s !== null).sort((a,b) => a.t-b.t);
  const gps = points.filter(p => [p.timeSeconds,p.longitude,p.latitude].every(Number.isFinite))
    .sort((a,b) => a.timeSeconds-b.timeSeconds);
  if (imu.length < 10 || gps.length < 8) return manual("运动样本不足，已使用输入偏移。");
  const end = imu.at(-1)!.t - 2;
  const heading = (time: number) => {
    let low=0, high=imu.length-1;
    while(low<high) { const mid=(low+high)>>>1; if(imu[mid].t<time) low=mid+1; else high=mid; }
    const a=imu[Math.max(0,low-1)],b=imu[low];
    return a.yaw+wrap(b.yaw-a.yaw)*Math.max(0,Math.min(1,(time-a.t)/(b.t-a.t||1)));
  };
  // Keep exactly the same GPS intervals for every candidate to avoid coverage bias.
  const intervals = gps.slice(1).flatMap((b,i) => {
    const a=gps[i],start=a.timeSeconds-estimate,stop=b.timeSeconds-estimate,dt=stop-start;
    const east=(b.longitude-a.longitude)*Math.cos(a.latitude*Math.PI/180),north=b.latitude-a.latitude;
    if(start<8 || stop>end-3 || dt<=0 || dt>15 || Math.hypot(east,north)*111195<10) return [];
    return [{start:a.timeSeconds,stop:b.timeSeconds,heading:Math.atan2(east,north),dt}];
  });
  if(intervals.length<7) return manual("有效 GPS 转向片段不足，已使用输入偏移。");
  const variation = intervals.slice(1).reduce((sum,r,i)=>sum+Math.abs(wrap(r.heading-intervals[i].heading)),0);
  if(variation<15*Math.PI/180) return manual("转向特征不明显，已使用输入偏移。");
  const score=(offset:number,sign:number,subset=intervals) => {
    const residuals=subset.map(r=>{
      let x=0,y=0;
      for(let i=0;i<=8;i++) { const v=heading(r.start-offset+(r.stop-r.start)*i/8); x+=Math.cos(v); y+=Math.sin(v); }
      return {v:wrap(r.heading-sign*Math.atan2(y,x)),w:r.dt};
    });
    const center=Math.atan2(residuals.reduce((s,r)=>s+r.w*Math.sin(r.v),0),residuals.reduce((s,r)=>s+r.w*Math.cos(r.v),0));
    return residuals.reduce((s,r)=>s+r.w*wrap(r.v-center)**2,0)/residuals.reduce((s,r)=>s+r.w,0);
  };
  const choices = [-1,1].flatMap(sign=>Array.from({length:7},(_,i)=>{
    const offset=estimate+i-3; return {offset,sign,error:score(offset,sign)};
  })).sort((a,b)=>a.error-b.error);
  const best=choices[0],baseline=score(estimate,best.sign);
  if(best.offset===estimate || Math.abs(best.offset-estimate)===3 || baseline<1e-8 || best.error>baseline*.8)
    return manual("未找到稳定的小幅修正，已使用输入偏移。");
  const halves=[intervals.slice(0,Math.ceil(intervals.length/2)),intervals.slice(Math.ceil(intervals.length/2))];
  if(halves.some(part=>score(best.offset,best.sign,part)>=score(estimate,best.sign,part)))
    return manual("前后片段的修正不一致，已使用输入偏移。");
  if(Math.sqrt(best.error)>8*Math.PI/180) return manual("镜头运动与轨迹差异较大，已使用输入偏移。");
  return {offsetSeconds:best.offset,adjustmentSeconds:best.offset-estimate,refined:true,reason:"已按前后转向片段自动微调。"};
}
