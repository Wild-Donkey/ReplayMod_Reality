// Submission IDs distinguish a completed frame from a merely initialized GPU.
// All exit paths remove abort listeners and timers, including backend failure.
export class RenderCompletion {
  private submitted = 0;
  private completed = 0;
  private failed = false;
  private readonly waiters = new Set<{version: number; finish(success: boolean): void}>();
  submit() { return ++this.submitted; }
  complete(version: number) {
    if (this.failed) return;
    this.completed = Math.max(this.completed, version);
    for (const waiter of [...this.waiters]) if (waiter.version <= this.completed) waiter.finish(true);
  }
  fail() { this.failed = true; for (const waiter of [...this.waiters]) waiter.finish(false); }
  wait(signal: AbortSignal, timeout = 3000): Promise<boolean> {
    if (this.failed || signal.aborted) return Promise.resolve(false);
    const version = this.submitted;
    if (this.completed >= version) return Promise.resolve(true);
    return new Promise(resolve => {
      let done = false;
      const onAbort = () => waiter.finish(false);
      const waiter = {version, finish: (success: boolean) => {
        if (done) return;
        done = true; clearTimeout(timer); signal.removeEventListener("abort", onAbort); this.waiters.delete(waiter); resolve(success);
      }};
      const timer = setTimeout(() => waiter.finish(false), timeout);
      this.waiters.add(waiter); signal.addEventListener("abort", onAbort, {once: true});
    });
  }
}
