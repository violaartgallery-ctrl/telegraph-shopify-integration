/**
 * A bounded, single-worker dispatcher for the temporary standalone host.
 * Business state remains in Neon: these timers are wake-ups, not the source of
 * truth. The watchdog reconstructs missing wake-ups after a process restart.
 */
export class InProcessRecoveryQueue<T> {
  private pending = new Map<string, { value: T; at: number }>();
  private running = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly run: (value: T) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly maxPending = 1000,
  ) {}

  enqueue(key: string, value: T, delayMs = 0): void {
    if (this.closed) throw new Error('Recovery queue is closed');
    if (!key || !Number.isFinite(delayMs)) throw new Error('Invalid recovery wake-up');
    if (this.pending.has(key)) return;
    if (this.pending.size >= this.maxPending) throw new Error('Recovery queue capacity reached');
    this.pending.set(key, { value, at: Date.now() + Math.min(86_400_000, Math.max(0, delayMs)) });
    this.schedule();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.pending.clear();
  }

  get size(): number { return this.pending.size; }

  private schedule(): void {
    if (this.closed || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    const next = [...this.pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) return;
    this.timer = setTimeout(() => { void this.drain(); }, Math.max(0, next[1].at - Date.now()));
  }

  private async drain(): Promise<void> {
    if (this.closed || this.running) return;
    const next = [...this.pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next || next[1].at > Date.now()) { this.schedule(); return; }
    this.pending.delete(next[0]);
    this.running = true;
    try { await this.run(next[1].value); }
    catch (error) { this.onError(error); }
    finally { this.running = false; this.schedule(); }
  }
}
