#!/usr/bin/env node
import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import http, { IncomingMessage } from 'http';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Duplex } from 'stream';
import * as pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';
import * as Diff2Html from 'diff2html';
import qrcode from 'qrcode-terminal';
import {
  startCloudflareTunnel,
  stopActiveTunnel,
  runCloudflaredLogin,
  ActiveTunnel,
} from './tunnel';

dotenv.config();

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '0.0.0.0';
const TARGET_CWD = path.resolve(process.env.CODEX_CWD || process.cwd());
const CODEX_CMD = process.env.CODEX_CMD || 'codex';
const AUTO_START_CODEX = process.env.AUTO_START_CODEX !== 'false';
const ENABLE_TUNNEL = process.env.ENABLE_TUNNEL !== 'false';
const CF_HOSTNAME = process.env.CF_HOSTNAME || 'codex.lmjjml.cc.cd';
const CF_TUNNEL_NAME = process.env.CF_TUNNEL_NAME || 'codex-relay';
const CF_TUNNEL_TOKEN = process.env.CF_TUNNEL_TOKEN || '';

let AUTH_TOKEN = (process.env.RELAY_AUTH_TOKEN || process.env.RELAY_PIN || '').trim();
let activeTunnel: ActiveTunnel | null = null;

// Brute-force rate limiter per IP
interface RateRecord {
  failures: number;
  blockedUntil: number;
}
const ipRateMap = new Map<string, RateRecord>();
const MAX_AUTH_FAILURES = 8;
const BLOCK_DURATION_MS = 5 * 60 * 1000;

function getClientIp(req: IncomingMessage | Request): string {
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim()) return cfIp.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function isIpBlocked(ip: string): boolean {
  const rec = ipRateMap.get(ip);
  if (!rec) return false;
  if (rec.blockedUntil > Date.now()) return true;
  if (rec.blockedUntil !== 0 && rec.blockedUntil <= Date.now()) {
    ipRateMap.delete(ip);
  }
  return false;
}

function recordAuthFailure(ip: string): void {
  const rec = ipRateMap.get(ip) || { failures: 0, blockedUntil: 0 };
  rec.failures += 1;
  if (rec.failures >= MAX_AUTH_FAILURES) {
    rec.blockedUntil = Date.now() + BLOCK_DURATION_MS;
    console.warn(`🚫 [Security] IP ${ip} blocked for 5 minutes due to repeated failed PIN attempts.`);
  }
  ipRateMap.set(ip, rec);
}

function clearAuthFailures(ip: string): void {
  ipRateMap.delete(ip);
}

function verifyAuthToken(candidate: string | undefined | null): boolean {
  if (!AUTH_TOKEN || !candidate) return false;
  const expectedHash = crypto.createHash('sha256').update(AUTH_TOKEN).digest();
  const candidateHash = crypto.createHash('sha256').update(String(candidate).trim()).digest();
  return crypto.timingSafeEqual(expectedHash, candidateHash);
}

function extractTokenFromRequest(req: IncomingMessage | Request): string {
  const headerToken = req.headers['x-relay-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  try {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const queryToken = parsedUrl.searchParams.get('token');
    if (queryToken) return queryToken.trim();
  } catch {
    // ignore URL parse error
  }
  return '';
}

async function ensureAuthTokenConfigured(): Promise<string> {
  if (AUTH_TOKEN) return AUTH_TOKEN;

  const envPath = path.join(process.cwd(), '.env');
  // Check if CLI arg --pin <value> was passed
  const pinArgIdx = process.argv.indexOf('--pin');
  if (pinArgIdx !== -1 && process.argv[pinArgIdx + 1]) {
    AUTH_TOKEN = process.argv[pinArgIdx + 1].trim();
  }

  // If running in interactive terminal and not under watch/non-TTY, prompt once with a 6s timeout fallback
  if (!AUTH_TOKEN && process.stdin.isTTY && !process.env.TSX_WATCH_PROCESS) {
    const defaultPin = String(crypto.randomInt(100000, 999999));
    AUTH_TOKEN = await new Promise<string>((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const timer = setTimeout(() => {
        rl.close();
        console.log(`\n⏱️  未输入，已自动生成 6 位安全访问 PIN 码: ${defaultPin}`);
        resolve(defaultPin);
      }, 8000);

      rl.question(
        `\n🔐 首次启动安全设置 — 请输入自定义访问密码/PIN 码 (直接回车或等待 8 秒将自动使用 [${defaultPin}]): `,
        (answer) => {
          clearTimeout(timer);
          rl.close();
          const chosen = answer.trim() || defaultPin;
          resolve(chosen);
        }
      );
    });
  }

  if (!AUTH_TOKEN) {
    AUTH_TOKEN = String(crypto.randomInt(100000, 999999));
  }

  // Persist to .env so restarts keep the same PIN
  try {
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    if (!envContent.includes('RELAY_AUTH_TOKEN=')) {
      const prefix = envContent.length > 0 && !envContent.endsWith('\n') ? '\n' : '';
      envContent += `${prefix}RELAY_AUTH_TOKEN=${AUTH_TOKEN}\n`;
      if (!envContent.includes('CF_HOSTNAME=')) {
        envContent += `CF_HOSTNAME=${CF_HOSTNAME}\n`;
      }
      fs.writeFileSync(envPath, envContent, 'utf8');
      console.log(`💾 已将访问密码保存至配置文件: ${envPath}`);
    }
  } catch {
    // ignore write error if read-only fs
  }

  return AUTH_TOKEN;
}

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

// Public Auth Verification Endpoint (Protected by Brute-Force Limiter)
app.post('/api/auth/verify', (req: Request, res: Response) => {
  const clientIp = getClientIp(req);
  if (isIpBlocked(clientIp)) {
    res.status(429).json({
      ok: false,
      error: 'Too many failed attempts. Please try again in 5 minutes.',
    });
    return;
  }

  const candidate = req.body?.token || extractTokenFromRequest(req);
  if (!verifyAuthToken(candidate)) {
    recordAuthFailure(clientIp);
    console.warn(`⚠️  [Security] Rejected invalid login attempt from IP: ${clientIp}`);
    res.status(401).json({
      ok: false,
      error: '访问密码 / Token 错误，请重新输入',
    });
    return;
  }

  clearAuthFailures(clientIp);
  res.json({
    ok: true,
    cwd: TARGET_CWD,
    tunnelUrl: activeTunnel?.url || null,
    hostname: CF_HOSTNAME,
  });
});

// Express Middleware: Protect all /api/* routes below
function requireApiAuth(req: Request, res: Response, next: NextFunction): void {
  const clientIp = getClientIp(req);
  if (isIpBlocked(clientIp)) {
    res.status(429).json({ ok: false, error: 'IP temporarily blocked due to failed auth attempts' });
    return;
  }

  const token = extractTokenFromRequest(req);
  if (!verifyAuthToken(token)) {
    recordAuthFailure(clientIp);
    res.status(401).json({ ok: false, error: 'Unauthorized: Valid PIN/Token required' });
    return;
  }

  clearAuthFailures(clientIp);
  next();
}

app.use('/api', requireApiAuth);

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    running: Boolean(ptyProcess),
    pid: ptyProcess?.pid ?? null,
    cwd: TARGET_CWD,
    codexCmd: CODEX_CMD,
    clients: clients.size,
    tunnelUrl: activeTunnel?.url ?? null,
    tunnelMode: activeTunnel?.mode ?? null,
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
const wss = new WebSocketServer({ noServer: true });

// Connection Isolation: Strictly authenticate every WebSocket upgrade request
server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
  const clientIp = getClientIp(request);

  try {
    const parsedUrl = new URL(request.url || '/', 'http://localhost');
    if (parsedUrl.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (isIpBlocked(clientIp)) {
      console.warn(`🚫 [Security] Blocked WebSocket upgrade from rate-limited IP: ${clientIp}`);
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const token = extractTokenFromRequest(request);
    if (!verifyAuthToken(token)) {
      recordAuthFailure(clientIp);
      console.warn(`🚫 [Security] Rejected unauthorized WebSocket connection from IP: ${clientIp}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    clearAuthFailures(clientIp);
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } catch {
    socket.destroy();
  }
});

wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
  const clientIp = getClientIp(request);
  clients.add(ws);
  console.log(`✅ [WebSocket] Authenticated client connected (${clientIp}), active=${clients.size}`);

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
      tunnelUrl: activeTunnel?.url ?? null,
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

// Strict Lifecycle Binding: Destroy Cloudflare Tunnel & PTY immediately on exit
let isShuttingDown = false;
function gracefulShutdown(reason: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n🛑 [Lifecycle] 正在关闭 Codex Relay (${reason})，销毁公网隧道与终端进程...`);

  stopActiveTunnel();

  if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch {
      // ignore
    }
    ptyProcess = null;
  }

  for (const ws of clients) {
    try {
      ws.close(1001, 'Server shutting down');
    } catch {
      // ignore
    }
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 800).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
process.on('exit', () => {
  stopActiveTunnel();
  if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch {
      // ignore
    }
  }
});

async function bootstrap(): Promise<void> {
  if (process.argv.includes('--cf-login')) {
    await runCloudflaredLogin();
    process.exit(0);
  }

  await ensureAuthTokenConfigured();
  spawnCodexPty();

  server.listen(PORT, HOST, async () => {
    const lanIp = getLocalLanIp();
    const lanMagicUrl = `http://${lanIp}:${PORT}/?token=${encodeURIComponent(AUTH_TOKEN)}`;

    console.log('====================================================');
    console.log('  🚀 Codex Relay — Mobile Codex CLI Bridge');
    console.log(`  📂 Workspace   : ${TARGET_CWD}`);
    console.log(`  🤖 Command     : ${CODEX_CMD}`);
    console.log(`  🔑 Access PIN  : ${AUTH_TOKEN}`);
    console.log(`  💻 Local URL   : http://localhost:${PORT}/?token=${encodeURIComponent(AUTH_TOKEN)}`);
    console.log(`  📱 Wi-Fi URL   : ${lanMagicUrl}`);
    console.log('====================================================');

    if (ENABLE_TUNNEL) {
      try {
        activeTunnel = await startCloudflareTunnel({
          port: PORT,
          authToken: AUTH_TOKEN,
          hostname: CF_HOSTNAME,
          tunnelName: CF_TUNNEL_NAME,
          tunnelToken: CF_TUNNEL_TOKEN,
        });
      } catch (err: any) {
        console.error(`⚠️  Cloudflare Tunnel 启动失败: ${err?.message || err}`);
        console.log('📱 局域网 Wi-Fi 扫码直连：');
        qrcode.generate(lanMagicUrl, { small: true });
      }
    } else {
      console.log('📱 局域网 Wi-Fi 扫码直连：');
      qrcode.generate(lanMagicUrl, { small: true });
    }
  });
}

if (require.main === module) {
  bootstrap();
}
