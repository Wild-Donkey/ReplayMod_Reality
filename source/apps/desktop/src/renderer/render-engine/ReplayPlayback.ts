import type { ReplayClock } from "./ReplayClock";

export class ReplayPlayback {
  private frame: number | null = null;
  private startedAt = 0;
  private startedTime = 0;
  private generation = 0;
  constructor(private readonly clock: ReplayClock, private readonly bounds: readonly [number, number]) {}

  play() {
    if (this.frame !== null) return;
    const generation = ++this.generation;
    const time = this.clock.current.time;
    this.startedTime = time === null || time >= this.bounds[1] ? this.bounds[0] : Math.max(this.bounds[0], time);
    this.startedAt = performance.now();
    this.clock.setTime(this.startedTime, "playback");
    const tick = (now: number) => {
      if (generation !== this.generation) return;
      this.frame = null;
      const time = Math.min(this.bounds[1], this.startedTime + now - this.startedAt);
      this.clock.setTime(time, time >= this.bounds[1] ? "interactive" : "playback");
      if (generation === this.generation && time < this.bounds[1]) this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  pause() {
    this.generation++;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.clock.setTime(this.clock.current.time);
  }

  step(direction: -1 | 1, fps = 30) {
    this.pause();
    const time = (this.clock.current.time ?? this.bounds[0]) + direction * 1000 / fps;
    this.clock.setTime(Math.max(this.bounds[0], Math.min(this.bounds[1], time)));
  }

  destroy() { this.pause(); }
}
