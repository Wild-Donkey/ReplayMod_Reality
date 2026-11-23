import { app } from "electron";
import { existsSync } from "node:fs";

export function installShutdown(cleanup: () => Promise<void>, forceCleanup: () => void) {
  let quitting = false;
  let cleaned = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  const quit = () => { if (!quitting) app.quit(); };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, quit);
  app.on("window-all-closed", quit);
  app.on("before-quit", () => {
    if (quitting) return;
    quitting = true;
    clearInterval(watchdog);
    deadline = setTimeout(() => {
      console.error("Timed out waiting for the desktop app to shut down.");
      try { forceCleanup(); }
      finally { app.exit(1); }
    }, 6000);
  });
  let cleaning = false;
  app.on("will-quit", event => {
    if (cleaned) return;
    event.preventDefault();
    if (cleaning) return;
    cleaning = true;
    void Promise.resolve().then(cleanup).catch(console.error).then(() => {
      cleaned = true;
      app.quit();
    });
  });
  app.once("quit", () => {
    clearTimeout(deadline);
    clearInterval(watchdog);
    for (const signal of signals) process.off(signal, quit);
  });

  return {
    isQuitting: () => quitting,
    watchLauncher(forgePid: number) {
      const stopFile = process.env.REPLAYMOD_STOP_FILE;
      const check = () => {
        if (stopFile && existsSync(stopFile)) { quit(); return; }
        if (process.platform !== "win32") {
          if (process.ppid <= 1 || process.ppid !== forgePid) quit();
          return;
        }
        try { process.kill(forgePid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") quit(); }
      };
      watchdog = setInterval(check, 250);
      watchdog.unref();
      check();
    },
  };
}
