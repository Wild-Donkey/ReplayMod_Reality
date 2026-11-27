import type {AlignmentPoint} from "./motion-alignment";
export interface MotionPoint extends AlignmentPoint {altitude?:number}
export interface MotionGpsResult {
 videoStartSeconds:number;videoEndSeconds:number;points:MotionPoint[];contextPoints:MotionPoint[];
 fittedWindows?:number;attitudeConstraints?:number;correctedPoints:number;curvedIntervals:number;smoothedIntervals:number;bridgedIntervals:number;reason:string;
}
