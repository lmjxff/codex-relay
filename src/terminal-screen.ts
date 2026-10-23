import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

/** One parsed screen for one PTY. All operations retain PTY byte order. */
export class TerminalScreen {
  private readonly terminal: Terminal;
  private readonly serializer = new SerializeAddon();
  private queue: Promise<void> = Promise.resolve();

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true, convertEol: true });
    this.terminal.loadAddon(this.serializer);
  }

  private enqueue(operation: () => void | Promise<void>): Promise<void> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  write(data: string, after: () => void): Promise<void> {
    return this.enqueue(() => new Promise<void>((resolve, reject) => {
      this.terminal.write(data, () => {
        try { after(); resolve(); } catch (error) { reject(error); }
      });
    }));
  }

  snapshot(after: (snapshot: { data: string; cols: number; rows: number }) => void): Promise<void> {
    return this.enqueue(() => after({ data: this.serializer.serialize(), cols: this.terminal.cols, rows: this.terminal.rows }));
  }

  resize(cols: number, rows: number, after: (snapshot: { data: string; cols: number; rows: number }) => void): Promise<void> {
    return this.enqueue(() => {
      this.terminal.resize(cols, rows);
      after({ data: this.serializer.serialize(), cols, rows });
    });
  }

  dispose(): Promise<void> {
    return this.enqueue(() => this.terminal.dispose());
  }
}
