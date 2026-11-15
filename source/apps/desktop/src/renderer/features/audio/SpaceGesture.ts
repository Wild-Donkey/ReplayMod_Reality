/** A tap plays; holding past the threshold records until key release or focus loss. */
export class SpaceGesture {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private held = false;
  private down = false;
  constructor(private callbacks: {tap(index: number): void; start(index: number): void; end(): void}, private threshold = 250) {}
  press(index: number) {
    if(this.down) return;
    this.down = true;
    this.timer = setTimeout(() => {this.timer = undefined; if(this.down) {this.held = true; this.callbacks.start(index);}}, this.threshold);
    this.index = index;
  }
  private index = 0;
  get active() {return this.down;}
  release(cancelTap = false) {
    if(!this.down) return;
    clearTimeout(this.timer); this.timer = undefined; this.down = false;
    const held = this.held; this.held = false;
    if(held) this.callbacks.end(); else if(!cancelTap) this.callbacks.tap(this.index);
  }
}
