let current: () => Promise<void> = async () => {};

export function registerFlush(fn: () => Promise<void>): () => void {
  current = fn;
  return () => {
    if (current === fn) current = async () => {};
  };
}

export function flushWork(): Promise<void> {
  return current();
}
