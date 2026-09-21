import { performance } from 'node:perf_hooks';
import type { TransferInfo } from '../shared/types';

const WINDOW_MS = 2000;
const UPDATE_MS = 250;
const BUCKET_MS = 100;

/** Counts newly acknowledged payload only; queue progress and resume offsets are
 * deliberately not inputs. A short rolling window also drops stalled rates to 0. */
export class TransferRate {
  private started = 0;
  private samples: { at: number; bytes: number }[] = [];
  constructor(private readonly now: () => number = () => performance.now()) { this.reset(); }

  reset(): void { this.started = this.now(); this.samples = []; }

  add(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return;
    const now = this.now();
    this.prune(now);
    const last = this.samples.at(-1);
    if (last && Math.floor(last.at / BUCKET_MS) === Math.floor(now / BUCKET_MS)) {
      last.bytes += bytes; last.at = now;
    } else this.samples.push({ at: now, bytes });
  }

  value(): number {
    const now = this.now();
    this.prune(now);
    const bytes = this.samples.reduce((sum, sample) => sum + sample.bytes, 0);
    // Avoid a huge initial spike from the first callback in the same clock tick.
    const duration = Math.max(BUCKET_MS, Math.min(WINDOW_MS, now - this.started));
    return Math.round(bytes * 1000 / duration);
  }

  private prune(now: number): void {
    while (this.samples.length && this.samples[0].at <= now - WINDOW_MS) this.samples.shift();
  }
}

/** One reporter per SFTP job. Only the network phase owns a timer; disposing,
 * cancelling or leaving that phase always removes it and clears the live rate. */
export class TransferProgress {
  private readonly rate: TransferRate;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private readonly aborted = () => this.dispose();

  constructor(
    private readonly info: TransferInfo,
    private readonly emit: (force?: boolean) => void,
    private readonly signal: AbortSignal,
    now?: () => number,
  ) {
    this.rate = new TransferRate(now);
    signal.addEventListener('abort', this.aborted, { once: true });
    if (signal.aborted) this.dispose();
  }

  phase(state: TransferInfo['state']): void {
    if (this.disposed) return;
    this.clearTimer();
    this.info.state = state;
    this.info.bytesPerSecond = undefined;
    this.info.verification = undefined;
    if (state === 'transferring') {
      this.rate.reset();
      this.info.bytesPerSecond = 0;
      this.timer = setInterval(() => {
        if (this.disposed || this.info.state !== 'transferring') return this.clearTimer();
        this.info.bytesPerSecond = this.rate.value();
        this.emit();
      }, UPDATE_MS);
      this.timer.unref();
    }
    this.emit(true);
  }

  transferred(bytes: number): void {
    if (this.disposed || this.info.state !== 'transferring') return;
    this.rate.add(bytes);
    this.info.bytesPerSecond = this.rate.value();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    this.signal.removeEventListener('abort', this.aborted);
    const hadRate = this.info.bytesPerSecond !== undefined;
    this.info.bytesPerSecond = undefined;
    if (hadRate) this.emit(true);
  }

  private clearTimer(): void { clearInterval(this.timer); this.timer = undefined; }
}
