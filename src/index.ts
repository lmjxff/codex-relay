import express, { Request, Response } from 'express';
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';
import * as Diff2Html from 'diff2html';

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '0.0.0.0';
const TARGET_CWD = path.resolve(process.env.CODEX_CWD || process.cwd());
const CODEX_CMD = process.env.CODEX_CMD || 'codex';
const AUTO_START_CODEX = process.env.AUTO_START_CODEX !== 'false';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

export interface GitFileStatus {
  code: string;
  file: string;
  staged: boolean;
  untracked: boolean;
}

interface WsClientMessage {
  type: 'input' | 'resize' | 'action' | 'restart' | 'ping';
  data?: string;
  cols?: number;
  rows?: number;
  action?: 'approve' | 'reject' | 'enter' | 'esc' | 'ctrl_c' | 'start_codex';
}

const MAX_BUFFER_CHARS = 64 * 1024;
let terminalBuffer = '';
let ptyProcess: pty.IPty | null = null;
const clients = new Set<WebSocket>();

function appendBuffer(chunk: string): void {
  terminalBuffer += chunk;
  if (terminalBuffer.length > MAX_BUFFER_CHARS) {
    terminalBuffer = terminalBuffer.slice(terminalBuffer.length - MAX_BUFFER_CHARS);
  }
}

function broadcast(payload: Record<string, unknown>): void {
  const serialized = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(serialized);
    }
  }
}

function resolveDefaultShell(): { shell: string; args: string[] } {
  if (os.platform() === 'win32') {
    return {
      shell: 'powershell.exe',
      args: ['-NoLogo'],
    };
  }
  return {
    shell: process.env.SHELL || '/bin/bash',
    args: ['-l'],
  };
}

function spawnCodexPty(cols = 80, rows = 24): pty.IPty {
  if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch {
      // ignore cleanup error
    }
    ptyProcess = null;
  }

  const { shell, args } = resolveDefaultShell();
  const proc = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: TARGET_CWD,
    env: {
      ...(process.env as Record<string, string>),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });

  ptyProcess = proc;

  const banner = `\r\n\x1b[1;36m[codex-relay]\x1b[0m Attached to workspace: \x1b[33m${TARGET_CWD}\x1b[0m\r\n`;
  appendBuffer(banner);
  broadcast({ type: 'output', data: banner });

  proc.onData((data: string) => {
    appendBuffer(data);
    broadcast({ type: 'output', data });
  });

  proc.onExit(({ exitCode, signal }) => {
    const msg = `\r\n\x1b[1;31m[codex-relay]\x1b[0m Process exited (code=${exitCode}, signal=${signal ?? 'none'}).\r\n`;
    appendBuffer(msg);
    broadcast({ type: 'output', data: msg });
    broadcast({ type: 'status', running: false, exitCode });
    ptyProcess = null;
  });

  if (AUTO_START_CODEX) {
    setTimeout(() => {
      if (ptyProcess === proc) {
        const lineEnding = os.platform() === 'win32' ? '\r\n' : '\n';
        proc.write(`${CODEX_CMD}${lineEnding}`);
      }
    }, 350);
  }

  broadcast({
    type: 'status',
    running: true,
    pid: proc.pid,
    cwd: TARGET_CWD,
    cmd: CODEX_CMD,
  });

  return proc;
}

function sendTerminalAction(action: WsClientMessage['action']): void {
  if (!ptyProcess) {
    spawnCodexPty();
  }
  if (!ptyProcess) return;

  const eol = os.platform() === 'win32' ? '\r' : '\n';
  switch (action) {
    case 'approve':
      ptyProcess.write(`y${eol}`);
      break;
    case 'reject':
      ptyProcess.write(`n${eol}`);
      break;
    case 'enter':
      ptyProcess.write('\r');
      break;
    case 'esc':
      ptyProcess.write('\x1b');
      break;
    case 'ctrl_c':
      ptyProcess.write('\x03');
      break;
    case 'start_codex':
      ptyProcess.write(`${CODEX_CMD}${eol}`);
      break;
  }
}

async function runGit(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: TARGET_CWD,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (err: any) {
    if (typeof err?.stdout === 'string' && err.stdout.length > 0) {
      return err.stdout;
    }
    throw err;
  }
}

async function buildUntrackedPatch(relPath: string): Promise<string> {
  try {
    const absPath = path.resolve(TARGET_CWD, relPath);
    if (!absPath.startsWith(TARGET_CWD)) return '';
    const stat = await fs.promises.stat(absPath);
    if (!stat.isFile() || stat.size > 256 * 1024) return '';
    const content = await fs.promises.readFile(absPath, 'utf8');
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const body = lines.map((line) => `+${line}`).join('\n');
    return [
      `diff --git a/${relPath} b/${relPath}`,
      `new file mode 100644`,
      `--- /dev/null`,
      `+++ b/${relPath}`,
      `@@ -0,0 +1,${lines.length} @@`,
      body,
      '',
    ].join('\n');
  } catch {
    return '';
  }
}

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    running: Boolean(ptyProcess),
    pid: ptyProcess?.pid ?? null,
    cwd: TARGET_CWD,
    codexCmd: CODEX_CMD,
    clients: clients.size,
  });
});

app.post('/api/action', (req: Request, res: Response) => {
  const action = req.body?.action as WsClientMessage['action'];
  if (!action) {
    res.status(400).json({ ok: false, error: 'Missing action field' });
    return;
  }
  sendTerminalAction(action);
  res.json({ ok: true, action });
});

app.get('/api/git/status', async (_req: Request, res: Response) => {
  try {
    const branchOut = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD');
    const statusOut = await runGit(['status', '--porcelain=v1']);
    const files: GitFileStatus[] = statusOut
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const code = line.slice(0, 2);
        const file = line.slice(3).trim();
        return {
          code: code.trim() || 'M',
          file,
          staged: code[0] !== ' ' && code[0] !== '?',
          untracked: code === '??',
        };
      });

    res.json({
      ok: true,
      cwd: TARGET_CWD,
      branch: branchOut.trim(),
      files,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      ok: false,
      error: error?.message || 'Failed to read git status',
    });
  }
});

app.get('/api/git/diff', async (req: Request, res: Response) => {
  try {
    const targetFile = typeof req.query.file === 'string' ? req.query.file.trim() : '';
    const hasHead = await runGit(['rev-parse', '--verify', 'HEAD'])
      .then(() => true)
      .catch(() => false);

    const diffArgs = hasHead ? ['diff', 'HEAD', '--unified=3'] : ['diff', '--unified=3'];
    if (targetFile) {
      diffArgs.push('--', targetFile);
    }

    let rawDiff = await runGit(diffArgs);

    if (!rawDiff.trim()) {
      const stagedArgs = ['diff', '--cached', '--unified=3'];
      if (targetFile) stagedArgs.push('--', targetFile);
      rawDiff = await runGit(stagedArgs);
    }

    const statusOut = await runGit(['status', '--porcelain=v1']);
    const untrackedFiles = statusOut
      .split(/\r?\n/)
      .filter((l) => l.startsWith('?? '))
      .map((l) => l.slice(3).trim())
      .filter((f) => !targetFile || f === targetFile);

    for (const untracked of untrackedFiles) {
      const patch = await buildUntrackedPatch(untracked);
      if (patch) {
        rawDiff += (rawDiff.endsWith('\n') || !rawDiff ? '' : '\n') + patch;
      }
    }

    const html = rawDiff.trim()
      ? Diff2Html.html(rawDiff, {
          drawFileList: true,
          matching: 'lines',
          outputFormat: 'line-by-line',
        })
      : '';

    res.json({
      ok: true,
      cwd: TARGET_CWD,
      file: targetFile || null,
      rawDiff,
      html,
      hasChanges: Boolean(rawDiff.trim()),
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      ok: false,
      error: error?.message || 'Failed to generate git diff',
    });
  }
});

export const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws: WebSocket) => {
  clients.add(ws);

  if (!ptyProcess) {
    spawnCodexPty();
  }

  ws.send(
    JSON.stringify({
      type: 'status',
      running: Boolean(ptyProcess),
      pid: ptyProcess?.pid ?? null,
      cwd: TARGET_CWD,
      cmd: CODEX_CMD,
    })
  );

  if (terminalBuffer) {
    ws.send(JSON.stringify({ type: 'output', data: terminalBuffer }));
  }

  ws.on('message', (raw: Buffer | string) => {
    try {
      const msg = JSON.parse(raw.toString()) as WsClientMessage;
      switch (msg.type) {
        case 'input':
          if (typeof msg.data === 'string') {
            if (!ptyProcess) spawnCodexPty();
            ptyProcess?.write(msg.data);
          }
          break;
        case 'resize':
          if (ptyProcess && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
            const cols = Math.max(20, Math.min(300, Math.floor(msg.cols)));
            const rows = Math.max(5, Math.min(120, Math.floor(msg.rows)));
            ptyProcess.resize(cols, rows);
          }
          break;
        case 'action':
          sendTerminalAction(msg.action);
          break;
        case 'restart':
          terminalBuffer = '';
          spawnCodexPty(msg.cols || 80, msg.rows || 24);
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          break;
      }
    } catch {
      // Ignore malformed JSON frames
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

function getLocalLanIp(): string {
  const interfaces = os.networkInterfaces();
  const candidates: { name: string; address: string; score: number }[] = [];

  for (const name of Object.keys(interfaces)) {
    const lowerName = name.toLowerCase();
    // Skip virtual/proxy/VPN/WSL adapters
    if (
      lowerName.includes('mihomo') ||
      lowerName.includes('clash') ||
      lowerName.includes('vethernet') ||
      lowerName.includes('wsl') ||
      lowerName.includes('docker') ||
      lowerName.includes('vmware') ||
      lowerName.includes('virtual') ||
      lowerName.includes('tun') ||
      lowerName.includes('tap')
    ) {
      continue;
    }

    for (const iface of interfaces[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (iface.mac === '00:00:00:00:00:00') continue;
      if (iface.address.startsWith('198.18.') || iface.address.startsWith('169.254.')) continue;

      let score = 10;
      if (lowerName.includes('wlan') || lowerName.includes('wi-fi') || lowerName.includes('wifi')) {
        score += 50;
      }
      if (iface.address.startsWith('192.168.')) {
        score += 30;
      } else if (iface.address.startsWith('10.') || iface.address.startsWith('172.')) {
        score += 10;
      }

      candidates.push({ name, address: iface.address, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address || '127.0.0.1';
}

if (require.main === module) {
  spawnCodexPty();
  server.listen(PORT, HOST, () => {
    const lanIp = getLocalLanIp();
    console.log('====================================================');
    console.log('  🚀 Codex Relay — Mobile Codex CLI Bridge');
    console.log(`  📂 Workspace : ${TARGET_CWD}`);
    console.log(`  🤖 Command   : ${CODEX_CMD}`);
    console.log(`  💻 Local URL : http://localhost:${PORT}`);
    console.log(`  📱 Mobile URL: http://${lanIp}:${PORT}`);
    console.log('====================================================');
  });
}
