import type {PointDataset} from "../../../../../../packages/data/src";
import type {MotionGpsResult} from "../../../../../../packages/media/src/gps-motion";

/** Derived timeline only: source arrays, identity, path and source selection remain untouched. */
export function withProcessedTrajectory(raw:PointDataset,result:MotionGpsResult):PointDataset {
 if(result.points.length<2)return raw;
 const start=result.points[0].timeSeconds*1000,end=result.points.at(-1)!.timeSeconds*1000;
 const coordinates:number[]=[],timestamps:number[]=[],altitudes:number[]=[];
 let cursor=0;
 const altitude=(time:number)=>{
  while(cursor<raw.timelineTimestamps.length-1&&raw.timelineTimestamps[cursor+1]<time)cursor++;
  const right=Math.min(cursor+1,raw.timelineTimestamps.length-1),dt=raw.timelineTimestamps[right]-raw.timelineTimestamps[cursor];
  const t=dt>0?Math.max(0,Math.min(1,(time-raw.timelineTimestamps[cursor])/dt)):0;
  return raw.timelineAltitudes[cursor]+(raw.timelineAltitudes[right]-raw.timelineAltitudes[cursor])*t;
 };
 const appendRaw=(i:number)=>{timestamps.push(raw.timelineTimestamps[i]);coordinates.push(raw.timelineCoordinates[i*2],raw.timelineCoordinates[i*2+1]);altitudes.push(raw.timelineAltitudes[i]);};
 let i=0;while(i<raw.timelineTimestamps.length&&raw.timelineTimestamps[i]<start)appendRaw(i++);
 for(const p of result.points){const time=p.timeSeconds*1000;timestamps.push(time);coordinates.push(p.longitude,p.latitude);altitudes.push(p.altitude??altitude(time));}
 while(i<raw.timelineTimestamps.length&&raw.timelineTimestamps[i]<=end)i++;
 while(i<raw.timelineTimestamps.length)appendRaw(i++);
 return {...raw,timelineCoordinates:coordinates,timelineTimestamps:timestamps,timelineAltitudes:altitudes};
}
