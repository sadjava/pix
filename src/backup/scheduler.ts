import { BACKUP_DEBOUNCE_MS } from '../model/types.ts';

export class BackupScheduler {
  private dueAt = 0;
  dirty = false;
  running = false;
  private now: () => number;
  private debounce: number;

  constructor(now: () => number = () => Date.now(), debounce = BACKUP_DEBOUNCE_MS) {
    this.now = now;
    this.debounce = debounce;
  }

  noteChange(): void {
    this.dirty = true;
    this.dueAt = this.now() + this.debounce;
  }

  flush(): void {
    if (this.dirty) this.dueAt = this.now();
  }

  shouldRun(options: { enabled: boolean; online: boolean; signedIn: boolean }): boolean {
    if (!options.enabled || !options.online || !options.signedIn || !this.dirty || this.running) return false;
    return this.now() >= this.dueAt;
  }

  markClean(): void {
    this.dirty = false;
    this.running = false;
  }
}

export function backoffMs(attempt: number, random = Math.random()): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, attempt));
  const jitter = Math.floor(random * base * 0.2);
  return base + jitter;
}
