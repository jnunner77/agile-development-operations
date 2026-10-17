/**
 * Run `task` now and then every `everyMs`, without keeping the process alive. A failure is
 * reported and the next run goes ahead. Returns a function that stops it.
 */
export function runEvery(everyMs: number, task: () => Promise<unknown>, onError: (error: unknown) => void): () => void {
  const run = () => {
    task().catch(onError);
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
