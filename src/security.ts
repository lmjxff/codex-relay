import crypto from 'crypto';
import { IncomingMessage } from 'http';
import { isIP } from 'net';

export function isLoopbackAddress(address = ''): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function getClientIp(req: IncomingMessage, trustLocalTunnel = false): string {
  const remote = req.socket?.remoteAddress || 'unknown';
  const forwarded = req.headers['cf-connecting-ip'];
  // An owned cloudflared process connects over loopback. LAN clients and
  // arbitrary reverse proxies cannot select their own rate-limit bucket.
  if (trustLocalTunnel && isLoopbackAddress(remote) && typeof forwarded === 'string' && isIP(forwarded.trim())) {
    return forwarded.trim();
  }
  return remote;
}

export function isLocalhostRequest(req: IncomingMessage): boolean {
  if (!isLoopbackAddress(req.socket?.remoteAddress) || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) {
    return false;
  }
  try {
    const host = new URL(`http://${req.headers.host || ''}`).hostname;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return false;
    const origin = req.headers.origin;
    return !origin || new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function verifyToken(expected: string, candidate: unknown): boolean {
  if (!expected || typeof candidate !== 'string' || candidate.length > 4096) return false;
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(expected).digest(),
    crypto.createHash('sha256').update(candidate.trim()).digest()
  );
}

export function createAuthToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

export class AuthRateLimiter {
  private readonly records = new Map<string, { failures: number; expires: number }>();

  constructor(private readonly now = Date.now, private readonly limit = 8, private readonly windowMs = 5 * 60 * 1000) {}

  isBlocked(ip: string): boolean {
    const record = this.records.get(ip);
    if (!record) return false;
    if (record.expires <= this.now()) {
      this.records.delete(ip);
      return false;
    }
    return record.failures >= this.limit;
  }

  fail(ip: string): void {
    const now = this.now();
    const previous = this.records.get(ip);
    const record = previous && previous.expires > now ? previous : { failures: 0, expires: now + this.windowMs };
    record.failures += 1;
    this.records.set(ip, record);
    if (this.records.size > 10000) {
      for (const [key, item] of this.records) if (item.expires <= now) this.records.delete(key);
      if (this.records.size > 10000) this.records.delete(this.records.keys().next().value!);
    }
  }

  clear(ip: string): void {
    this.records.delete(ip);
  }
}
