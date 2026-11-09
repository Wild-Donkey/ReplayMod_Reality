export type ReplayClockMode = "interactive" | "playback" | "export";

export interface ReplayClockSnapshot {
  readonly time: number | null;
  readonly frame: number;
  readonly mode: ReplayClockMode;
}

type Listener = (snapshot: ReplayClockSnapshot) => void;

export class ReplayClock {
  private snapshot: ReplayClockSnapshot = {time: null, frame: 0, mode: "interactive"};
  private readonly listeners = new Set<Listener>();

  get current() { return this.snapshot; }

  setTime(time: number | null, mode: ReplayClockMode = "interactive") {
    if (this.snapshot.time === time && this.snapshot.mode === mode) return;
    this.snapshot = {time, mode, frame: this.snapshot.frame + 1};
    this.emit();
  }

  step(time: number, frame: number) {
    this.snapshot = {time, frame, mode: "export"};
    this.emit();
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
