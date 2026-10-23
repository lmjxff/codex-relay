import { ChildProcess, spawn, execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { bin as cloudflaredBin, install as installCloudflared } from 'cloudflared';

const execFileAsync = promisify(execFile);

export interface TunnelOptions {
  port: number;
  hostname?: string;
  tunnelName?: string;
  tunnelToken?: string;
  localQrPageUrl?: string;
  overwriteDns?: boolean;
  manageDns?: boolean;
  timeoutMs?: number;
}

export interface ActiveTunnel {
  url: string;
  mode: 'custom-token' | 'custom-cert' | 'quick-trycloudflare';
  process: ChildProcess;
  isReady: () => boolean;
  stop: () => void;
}

let activeTunnelProcess: ChildProcess | null = null;

export function stopActiveTunnel(): void {
  const child = activeTunnelProcess;
  activeTunnelProcess = null;
  if (!child || child.exitCode !== null) return;
  try {
    child.kill('SIGTERM');
    if (os.platform() === 'win32' && child.pid) {
      const cleanup = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
      cleanup.on('error', () => {});
    }
  } catch {
    // Cleanup is best effort; callers must not advertise the stopped process.
  }
}

async function ensureBinary(): Promise<string> {
  if (!fs.existsSync(cloudflaredBin)) {
    console.log('[Cloudflare] Installing cloudflared for the first tunnel setup...');
    await installCloudflared(cloudflaredBin);
  }
  return cloudflaredBin;
}

export async function runCloudflaredLogin(): Promise<void> {
  const binPath = await ensureBinary();
  console.log('[Cloudflare] Select a domain you control in the authorization page.');
  const child = spawn(binPath, ['tunnel', 'login'], { stdio: 'inherit', windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error('Unable to start cloudflared login.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Cloudflared login did not complete.')));
  });
}

async function ensureNamedTunnelAndRoute(binPath: string, name: string, hostname: string, overwrite = false): Promise<void> {
  try {
    await execFileAsync(binPath, ['tunnel', 'info', name], { windowsHide: true });
  } catch {
    await execFileAsync(binPath, ['tunnel', 'create', name], { windowsHide: true });
  }
  // Existing DNS records are preserved unless the owner explicitly opts in.
  const args = ['tunnel', 'route', 'dns'];
  if (overwrite) args.push('--overwrite-dns');
  args.push(name, hostname);
  try {
    await execFileAsync(binPath, args, { windowsHide: true });
  } catch {
    throw new Error('DNS route was not created. Check domain authorization and existing records; automatic overwrite is disabled by default.');
  }
}

function validateHostname(hostname: string): void {
  if (!hostname) return;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(hostname)) {
    throw new Error('CF_HOSTNAME must be a hostname only, without a scheme, port or path.');
  }
}

export async function startCloudflareTunnel(options: TunnelOptions): Promise<ActiveTunnel> {
  const hostname = (options.hostname || '').trim();
  const tunnelName = (options.tunnelName || 'codex-relay').trim();
  const tunnelToken = (options.tunnelToken || '').trim();
  validateHostname(hostname);
  if (tunnelToken && !hostname) throw new Error('Token mode requires the hostname configured for that tunnel. Set CF_HOSTNAME.');
  const certificate = path.join(os.homedir(), '.cloudflared', 'cert.pem');
  if (hostname && !tunnelToken && !fs.existsSync(certificate)) {
    throw new Error('Custom-domain mode requires cloudflared login or CF_TUNNEL_TOKEN. Local access remains available.');
  }
  const binPath = await ensureBinary();
  const localTarget = `http://127.0.0.1:${options.port}`;
  let mode: ActiveTunnel['mode'] = 'quick-trycloudflare';
  let url = '';
  let args = ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', localTarget];
  const childEnv = { ...process.env };
  delete childEnv.RELAY_AUTH_TOKEN;
  delete childEnv.RELAY_PIN;
  delete childEnv.CF_TUNNEL_TOKEN;
  // Do not inherit unrelated cloudflared settings from another local tunnel.
  delete childEnv.TUNNEL_TOKEN;
  delete childEnv.TUNNEL_TOKEN_FILE;
  if (tunnelToken) {
    mode = 'custom-token';
    url = `https://${hostname}`;
    childEnv.TUNNEL_TOKEN = tunnelToken;
    args = ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run'];
  } else if (hostname) {
    if (options.manageDns === false) {
      // Reuse mode is read-only against the account: no tunnel creation or
      // DNS routing command, even when the existing tunnel cannot be found.
      try { await execFileAsync(binPath, ['tunnel', 'info', tunnelName], { windowsHide: true }); }
      catch { throw new Error('Existing named tunnel unavailable. Check CF_TUNNEL_NAME and authorization; DNS management is disabled.'); }
    } else {
      await ensureNamedTunnelAndRoute(binPath, tunnelName, hostname, options.overwriteDns);
    }
    mode = 'custom-cert';
    url = `https://${hostname}`;
    args = ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run', '--url', localTarget, tunnelName];
  }

  stopActiveTunnel();
  const child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv });
  activeTunnelProcess = child;
  let ready = false;
  let registered = false;
  let output = '';
  return new Promise<ActiveTunnel>((resolve, reject) => {
    let settled = false;
    const fail = (message: string) => {
      ready = false;
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (activeTunnelProcess === child) stopActiveTunnel();
      reject(new Error(message));
    };
    const timeout = setTimeout(() => fail('Tunnel did not report a registered connection before the startup timeout.'), options.timeoutMs ?? 30000);
    const readOutput = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-32768);
      if (!hostname) {
        const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match) url = match[0];
      }
      if (/Registered tunnel connection/i.test(output)) registered = true;
      if (!settled && url && registered) {
        settled = true;
        ready = true;
        clearTimeout(timeout);
        console.log(`[Cloudflare] Registered connection (${mode}). Open the local /qr page to pair your device.`);
        resolve({
          url, mode, process: child,
          isReady: () => ready && !child.killed && child.exitCode === null,
          stop: () => { ready = false; if (activeTunnelProcess === child) stopActiveTunnel(); },
        });
      }
    };
    // Keep draining both streams after startup; do not print credential-bearing
    // URLs or arbitrary subprocess output to the application console.
    child.stdout?.on('data', readOutput);
    child.stderr?.on('data', readOutput);
    child.once('error', () => fail('Unable to start cloudflared. Check the installed binary and local permissions.'));
    child.once('exit', () => {
      ready = false;
      if (activeTunnelProcess === child) activeTunnelProcess = null;
      fail('Cloudflared exited before a usable connection was established.');
    });
  });
}
