// A detached terminal or a closed log pipe can reject writes from both
// console and Node's warning printer. Handle only failures of these streams.
const disconnectedOutputErrors = new Set(["EIO", "EPIPE", "EBADF", "ERR_STREAM_DESTROYED"]);

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (!error.code || !disconnectedOutputErrors.has(error.code)) throw error;
  });
}
