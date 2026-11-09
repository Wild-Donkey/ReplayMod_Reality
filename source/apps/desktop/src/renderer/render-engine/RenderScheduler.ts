export type RenderInvalidation = "scene" | "clock" | "layout";

export class RenderScheduler {
  private readonly pending = new Set<RenderInvalidation>();
  private frame: number | null = null;

  constructor(private readonly render: (invalidations: ReadonlySet<RenderInvalidation>) => void) {}

  invalidate(reason: RenderInvalidation) {
    this.pending.add(reason);
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.flush();
    });
  }

  // Render immediately instead of waiting for the next animation frame. Used
  // for camera changes that must land in the same frame the map produced them.
  flushSync() {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.flush();
  }

  private flush() {
    if (this.pending.size === 0) return;
    const invalidations = new Set(this.pending);
    this.pending.clear();
    this.render(invalidations);
  }

  destroy() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.pending.clear();
  }
}
