/**
 * @req REQ-204 — 手机同步配置的一键传递。
 *
 * PC 生成 `<appUrl>#sync=<base64url(JSON{u,t})>`，手机扫码打开即自动写入配置，
 * 免去手输 64 位 token。配置放在 URL **hash** 里：hash 不会发往服务器，
 * 只在扫码瞬间由手机浏览器读取一次。
 */
import type { SyncConfig } from './sync';

export interface SharedSyncConfig {
  u: string;
  t: string;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function buildSyncLink(appUrl: string, config: Pick<SyncConfig, 'serverUrl' | 'token'>): string {
  const payload = toBase64Url(JSON.stringify({ u: config.serverUrl.trim(), t: config.token.trim() }));
  return `${appUrl.replace(/#.*$/, '')}#sync=${payload}`;
}

export function parseSyncLink(hash: string): SharedSyncConfig | null {
  const marker = '#sync=';
  if (!hash.startsWith(marker)) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(hash.slice(marker.length))) as Partial<SharedSyncConfig>;
    if (typeof parsed.u !== 'string' || typeof parsed.t !== 'string') return null;
    if (!parsed.u.trim() || parsed.t.trim().length < 16) return null;
    return { u: parsed.u.trim(), t: parsed.t.trim() };
  } catch {
    return null;
  }
}
