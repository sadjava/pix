import type { LocalStatus } from '../../model/types.ts';
import { isQuotaError } from '../repository.ts';

export class SaveQueue {
  status: LocalStatus = 'saved-local';
  errorKind: 'quota' | 'unknown' | null = null;
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();
  private onChange: (() => void) | null = null;

  listen(listener: () => void): void {
    this.onChange = listener;
  }

  noteChange(): number {
    this.generation += 1;
    this.status = 'dirty';
    this.emit();
    return this.generation;
  }

  enqueue(generation: number, job: () => Promise<void>): Promise<void> {
    this.status = 'saving-local';
    this.emit();
    const run = this.tail.then(async () => {
      try {
        await job();
        if (this.status === 'local-save-error') return;
        this.status = generation === this.generation ? 'saved-local' : 'dirty';
        this.errorKind = null;
      } catch (error) {
        this.status = 'local-save-error';
        this.errorKind = isQuotaError(error) ? 'quota' : 'unknown';
        throw error;
      } finally {
        this.emit();
      }
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  flush(): Promise<void> {
    return this.tail;
  }

  private emit(): void {
    this.onChange?.();
  }
}
