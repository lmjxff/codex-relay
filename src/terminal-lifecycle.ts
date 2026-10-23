import type { IPty } from 'node-pty';

export function attachPtyLifecycle(
  process: IPty,
  current: () => IPty | null,
  onData: (data: string) => void,
  onExit: (event: { exitCode: number; signal?: number }) => void
): void {
  process.onData(data => {
    if (current() === process) onData(data);
  });
  process.onExit(event => {
    if (current() === process) onExit(event);
  });
}

export function terminalSize(cols = 80, rows = 24) {
  return {
    cols: Number.isFinite(cols) ? Math.max(20, Math.min(300, Math.floor(cols))) : 80,
    rows: Number.isFinite(rows) ? Math.max(5, Math.min(120, Math.floor(rows))) : 24,
  };
}
