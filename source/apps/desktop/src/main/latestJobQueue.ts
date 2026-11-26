export class LatestJobQueue<Job> {
  private current?: Job;
  private waiting?: Job;
  private active?: { job: Job; controller: AbortController };
  private busy = false;

  constructor(
    private readonly run: (job: Job, isCurrent: () => boolean, signal: AbortSignal) => Promise<void>,
    private readonly onError: (error: unknown) => void = console.error,
  ) {}

  post(job: Job) {
    this.current = this.waiting = job;
    this.active?.controller.abort();
    if (!this.busy) void this.drain();
  }

  cancel(matches: (job: Job) => boolean) {
    if (this.current !== undefined && matches(this.current)) this.current = undefined;
    if (this.waiting !== undefined && matches(this.waiting)) this.waiting = undefined;
    if (this.active && matches(this.active.job)) this.active.controller.abort();
  }

  private async drain() {
    this.busy = true;
    try {
      while (this.waiting !== undefined) {
        const job = this.waiting;
        const controller = new AbortController();
        this.active = { job, controller };
        this.waiting = undefined;
        try {
          await this.run(job, () => this.current === job, controller.signal);
        } catch (error) {
          if (!controller.signal.aborted) this.onError(error);
        } finally {
          this.active = undefined;
          if (this.current === job) this.current = undefined;
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
