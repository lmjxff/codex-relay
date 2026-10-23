import type { IPty } from 'node-pty';

export function attachPtyLifecycle(
  process: IPty,
  current: () => IPty | null,
  onData: (data: string) => void,
  onExit: (event: PtyExit) => void
): void {
  process.onData(data => {
    if (current() === process) onData(data);
  });
  process.onExit(event => {
    if (current() === process) onExit(normalizePtyExit(event));
  });
}

export interface PtyExit {
  exitCode: number | null;
  signal: number | null;
  kind: 'normal' | 'error' | 'unknown';
}

export function normalizePtyExit(event: { exitCode?: number; signal?: number }): PtyExit {
  const exitCode = Number.isFinite(event.exitCode) ? event.exitCode! : null;
  const signal = Number.isFinite(event.signal) && event.signal !== 0 ? event.signal! : null;
  return { exitCode, signal, kind: signal !== null || (exitCode !== null && exitCode !== 0)
    ? 'error' : exitCode === 0 ? 'normal' : 'unknown' };
}

export function ptyExitMessage(event: PtyExit): string {
  if (event.kind === 'normal') return 'Terminal session ended normally. Use Restart to start a new session.';
  if (event.kind === 'unknown') return 'Terminal connection closed; the system did not report an exit status. Use Restart to reconnect.';
  const details = [event.exitCode !== null ? `code=${event.exitCode}` : '', event.signal !== null ? `signal=${event.signal}` : ''].filter(Boolean);
  return `Terminal session ended (${details.join(', ')}). Check the preceding output before restarting.`;
}

export function terminalSize(cols = 80, rows = 24) {
  return {
    cols: Number.isFinite(cols) ? Math.max(20, Math.min(300, Math.floor(cols))) : 80,
    rows: Number.isFinite(rows) ? Math.max(5, Math.min(120, Math.floor(rows))) : 24,
  };
}

export function sharedTerminalSize(sizes: Iterable<{ cols: number; rows: number }>, fallback = terminalSize()) {
  const valid = [...sizes].map(size => terminalSize(size.cols, size.rows));
  return valid.length ? {
    cols: Math.min(...valid.map(size => size.cols)), rows: Math.min(...valid.map(size => size.rows)),
  } : fallback;
}
