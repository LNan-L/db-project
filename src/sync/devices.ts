/**
 * @req REQ-204 — 设备注册表。
 *
 * 每次 pull/push 服务端都会记录 deviceId + 设备名 + 最近活跃时间，
 * 面板据此展示"哪些设备在同步"。Phase 4.1 增加吊销/恢复：
 * 被吊销的设备 id 会挡住后续 pull/push，避免旧记录被下一次同步重新注册回来。
 */
import type { FetchLike, SyncConfig } from './sync';

export interface RemoteDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeen: string;
}

export interface RevokedDevice {
  id: string;
  name: string;
  revokedAt: string;
}

export interface DeviceRegistry {
  devices: RemoteDevice[];
  revoked: RevokedDevice[];
}

function endpoint(config: SyncConfig, path: string): string {
  return `${config.serverUrl.replace(/\/+$/, '')}${path}`;
}

function authInit(config: SyncConfig, extra?: RequestInit): RequestInit {
  return {
    ...extra,
    headers: { Authorization: `Bearer ${config.token}`, ...(extra?.headers ?? {}) }
  };
}

export async function fetchDeviceRegistry(
  config: SyncConfig,
  fetchImpl: FetchLike = fetch
): Promise<DeviceRegistry> {
  const response = await fetchImpl(endpoint(config, '/api/v1/devices'), authInit(config));
  if (!response.ok) return { devices: [], revoked: [] };
  try {
    const body = (await response.json()) as { devices?: RemoteDevice[]; revoked?: RevokedDevice[] };
    return { devices: body.devices ?? [], revoked: body.revoked ?? [] };
  } catch {
    return { devices: [], revoked: [] };
  }
}

export async function fetchDevices(
  config: SyncConfig,
  fetchImpl: FetchLike = fetch
): Promise<RemoteDevice[]> {
  const registry = await fetchDeviceRegistry(config, fetchImpl);
  return registry.devices;
}

async function deviceAction(
  config: SyncConfig,
  path: string,
  fetchImpl: FetchLike
): Promise<boolean> {
  try {
    const response = await fetchImpl(endpoint(config, path), authInit(config, { method: 'DELETE' }));
    return response.ok;
  } catch {
    return false;
  }
}

/** 吊销：移出设备列表并挡住该设备的后续同步（笔记与版本不受影响）。 */
export async function revokeDevice(
  config: SyncConfig,
  deviceId: string,
  fetchImpl: FetchLike = fetch
): Promise<boolean> {
  return deviceAction(config, `/api/v1/devices/${encodeURIComponent(deviceId)}`, fetchImpl);
}

/** 撤销吊销：允许该设备 id 下次同步时重新注册。 */
export async function restoreDevice(
  config: SyncConfig,
  deviceId: string,
  fetchImpl: FetchLike = fetch
): Promise<boolean> {
  return deviceAction(config, `/api/v1/revoked-devices/${encodeURIComponent(deviceId)}`, fetchImpl);
}
