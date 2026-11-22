export class LatestJobQueue<Job> {
  private current?: Job;
  private waiting?: Job;
  private busy = false;

  constructor(
    private readonly run: (job: Job, isCurrent: () => boolean) => Promise<void>,
    private readonly onError: (error: unknown) => void = console.error,
  ) {}

  post(job: Job) {
    this.current = this.waiting = job;
    if (!this.busy) void this.drain();
  }

  cancel(matches: (job: Job) => boolean) {
    if (this.current !== undefined && matches(this.current)) this.current = undefined;
    if (this.waiting !== undefined && matches(this.waiting)) this.waiting = undefined;
  }

  private async drain() {
    this.busy = true;
    try {
      while (this.waiting !== undefined) {
        const job = this.waiting;
        this.waiting = undefined;
        try {
          await this.run(job, () => this.current === job);
        } catch (error) {
          this.onError(error);
        } finally {
          if (this.current === job) this.current = undefined;
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
