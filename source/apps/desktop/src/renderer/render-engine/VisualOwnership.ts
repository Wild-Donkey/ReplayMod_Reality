export interface ReplayVisualOwnership {readonly timeline: boolean; readonly elevation: boolean; readonly annotations?: boolean; readonly handles?: boolean; readonly photos?: boolean; readonly footprint?: boolean; readonly "timeline-density"?: boolean}
export function sameVisualOwnership(a: ReplayVisualOwnership, b: ReplayVisualOwnership) {
  return (Object.keys({...a, ...b}) as (keyof ReplayVisualOwnership)[]).every(channel => Boolean(a[channel]) === Boolean(b[channel]));
}

export class VisualOwnership {
  private snapshot: ReplayVisualOwnership = {timeline: false, elevation: false};
  private readonly listeners = new Set<() => void>();
  get current() { return this.snapshot; }
  set(snapshot: ReplayVisualOwnership) {
    if (sameVisualOwnership(snapshot, this.snapshot)) return;
    this.snapshot = {...snapshot};
    for (const notify of this.listeners) notify();
  }
  subscribe(notify: () => void) { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; }
}
