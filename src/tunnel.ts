import { ChildProcess, spawn, execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { bin as cloudflaredBin, install as installCloudflared } from 'cloudflared';
import qrcode from 'qrcode-terminal';

const execFileAsync = promisify(execFile);

export interface TunnelOptions {
  port: number;
  authToken: string;
  hostname?: string;
  tunnelName?: string;
  tunnelToken?: string;
}

export interface ActiveTunnel {
  url: string;
  mode: 'custom-token' | 'custom-cert' | 'quick-trycloudflare';
  process: ChildProcess;
  stop: () => void;
}

let activeTunnelProcess: ChildProcess | null = null;

export function stopActiveTunnel(): void {
  if (activeTunnelProcess) {
    try {
      activeTunnelProcess.kill('SIGTERM');
      if (os.platform() === 'win32' && activeTunnelProcess.pid) {
        spawn('taskkill', ['/PID', String(activeTunnelProcess.pid), '/T', '/F'], {
          stdio: 'ignore',
        });
      }
    } catch {
      // ignore cleanup errors
    }
    activeTunnelProcess = null;
  }
}

async function ensureBinary(): Promise<string> {
  if (!fs.existsSync(cloudflaredBin)) {
    console.log('⬇️  Downloading cloudflared binary for first-time setup...');
    await installCloudflared(cloudflaredBin);
  }
  return cloudflaredBin;
}

function getCloudflaredCertPath(): string {
  return path.join(os.homedir(), '.cloudflared', 'cert.pem');
}

export async function runCloudflaredLogin(): Promise<void> {
  const binPath = await ensureBinary();
  console.log('====================================================');
  console.log('  🔐 Cloudflare Tunnel 域名授权登录 (lmjjml.cc.cd)');
  console.log('  请在弹出的浏览器页面中选择你的域名并点击 Authorize');
  console.log('====================================================');
  const child = spawn(binPath, ['tunnel', 'login'], {
    stdio: 'inherit',
  });
  await new Promise<void>((resolve, reject) => {
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`cloudflared login exited with code ${code}`));
    });
  });
}

async function ensureNamedTunnelAndRoute(
  binPath: string,
  tunnelName: string,
  hostname: string
): Promise<void> {
  // 1. Check if tunnel already exists, otherwise create it
  try {
    await execFileAsync(binPath, ['tunnel', 'info', tunnelName]);
  } catch {
    console.log(`🔧 Creating Cloudflare named tunnel "${tunnelName}"...`);
    try {
      await execFileAsync(binPath, ['tunnel', 'create', tunnelName]);
    } catch {
      // May already exist in account
    }
  }

  // 2. Route custom hostname CNAME to the named tunnel
  console.log(`🌐 Binding DNS route: https://${hostname} -> tunnel "${tunnelName}"...`);
  await execFileAsync(binPath, [
    'tunnel',
    'route',
    'dns',
    '--overwrite-dns',
    tunnelName,
    hostname,
  ]);
}

export function printTunnelBanner(publicUrl: string, authToken: string, modeLabel: string): void {
  const magicUrl = `${publicUrl.replace(/\/$/, '')}/?token=${encodeURIComponent(authToken)}`;
  console.log('\n====================================================');
  console.log(`  🌍 Cloudflare 公网隧道已就绪 (${modeLabel})`);
  console.log(`  🔗 公网地址 : ${publicUrl}`);
  console.log(`  🔑 访问密码 : ${authToken}`);
  console.log(`  ⚡ 免输密直连: ${magicUrl}`);
  console.log('----------------------------------------------------');
  console.log('  📱 手机微信/相机扫码一键登录远程控制 (4G/5G 通用)：');
  qrcode.generate(magicUrl, { small: true });
  console.log('====================================================\n');
}

export async function startCloudflareTunnel(options: TunnelOptions): Promise<ActiveTunnel> {
  const binPath = await ensureBinary();
  const localTarget = `http://127.0.0.1:${options.port}`;
  const hostname = (options.hostname || 'codex.lmjjml.cc.cd').trim();
  const tunnelName = (options.tunnelName || 'codex-relay').trim();
  const tunnelToken = (options.tunnelToken || '').trim();
  const certPath = getCloudflaredCertPath();

  stopActiveTunnel();

  // Mode 1: Zero Trust Tunnel Token provided
  if (tunnelToken) {
    const publicUrl = `https://${hostname}`;
    const child = spawn(
      binPath,
      ['tunnel', '--no-autoupdate', 'run', '--token', tunnelToken, '--url', localTarget],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    activeTunnelProcess = child;

    printTunnelBanner(publicUrl, options.authToken, `自定义域名 Token 模式: ${hostname}`);
    return {
      url: publicUrl,
      mode: 'custom-token',
      process: child,
      stop: stopActiveTunnel,
    };
  }

  // Mode 2: Named tunnel with ~/.cloudflared/cert.pem
  if (fs.existsSync(certPath) && hostname) {
    try {
      await ensureNamedTunnelAndRoute(binPath, tunnelName, hostname);
      const publicUrl = `https://${hostname}`;
      const child = spawn(
        binPath,
        ['tunnel', '--no-autoupdate', 'run', '--url', localTarget, tunnelName],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      activeTunnelProcess = child;

      printTunnelBanner(publicUrl, options.authToken, `专属域名绑定: ${hostname}`);
      return {
        url: publicUrl,
        mode: 'custom-cert',
        process: child,
        stop: stopActiveTunnel,
      };
    } catch (err: any) {
      console.warn(
        `⚠️  无法自动绑定自定义域名 ${hostname} (${err?.message || '未知错误'})，自动回退至临时公网隧道...`
      );
    }
  } else if (hostname) {
    console.log(
      `💡 提示: 尚未检测到 Cloudflare 授权证书 (~/.cloudflared/cert.pem)。`
    );
    console.log(
      `   如需启用固定域名 https://${hostname}，可运行一次: npm run cf:login`
    );
    console.log('   正在为你自动启动免配置 Cloudflare 临时公网隧道...');
  }

  // Mode 3: Quick Tunnel (trycloudflare.com)
  const child = spawn(binPath, ['tunnel', '--no-autoupdate', '--url', localTarget], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeTunnelProcess = child;

  const publicUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Cloudflare Tunnel 启动超时 (25s)'));
    }, 25000);

    const onOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timeout);
        child.stdout?.off('data', onOutput);
        child.stderr?.off('data', onOutput);
        resolve(match[0]);
      }
    };

    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`cloudflared exited early with code ${code}`));
    });
  });

  printTunnelBanner(publicUrl, options.authToken, 'Quick Tunnel 临时公网域名');

  return {
    url: publicUrl,
    mode: 'quick-trycloudflare',
    process: child,
    stop: stopActiveTunnel,
  };
}
