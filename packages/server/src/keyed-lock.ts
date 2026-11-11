/** Runs tasks one at a time per key; tasks of different keys run concurrently. */
export class KeyedLock {
  /** The last task queued for each key, settled; dropped once nothing follows it. */
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Runs `task` once every task queued before it for `key` has settled. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const run = (this.tails.get(key) ?? Promise.resolve()).then(task);
    const settled = run.catch(() => {});
    this.tails.set(key, settled);
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return run;
  }
}
