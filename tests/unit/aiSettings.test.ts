import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { PkeDatabase, ensureSchema } from '../../src/storage/db';
import {
  DEFAULT_AI_SETTINGS,
  DEFAULT_CHAT_ENDPOINT,
  DEFAULT_EMBEDDING_ENDPOINT,
  baseUrlOrigin,
  describeRemoteSend,
  endpointBlockedReason,
  isLoopbackBaseUrl,
  isValidBaseUrl,
  loadAiSettings,
  normalizeAiSettings,
  saveAiSettings,
  type AiEndpoint,
  type AiSettings
} from '../../src/ai/settings';

let seq = 0;
const names: string[] = [];
const instances: PkeDatabase[] = [];

function makeDb(): PkeDatabase {
  const name = `pke-ai-${Date.now()}-${++seq}`;
  names.push(name);
  const database = new PkeDatabase(name);
  instances.push(database);
  return database;
}

afterEach(async () => {
  for (const database of instances.splice(0)) database.close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

function endpoint(patch: Partial<AiEndpoint> = {}): AiEndpoint {
  return {
    baseUrl: 'http://ai.example.com/v1',
    model: 'm',
    apiKey: 'secret',
    remoteAllowed: true,
    remoteConsentAt: '2026-11-12T10:00:00.000Z',
    remoteConsentBaseUrl: 'http://ai.example.com',
    ...patch
  };
}

describe('AI settings (dual endpoint)', () => {
  it('defaults to DeepSeek chat + SiliconFlow embedding, both unauthorized', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const loaded = await loadAiSettings(database);
    expect(loaded).toEqual(DEFAULT_AI_SETTINGS);
    expect(loaded.chat.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(loaded.chat.model).toBe('deepseek-chat');
    expect(loaded.embedding.baseUrl).toBe('https://api.siliconflow.cn/v1');
    expect(loaded.embedding.model).toBe('BAAI/bge-m3');
    expect(loaded.chat.remoteAllowed).toBe(false);
    expect(loaded.embedding.remoteAllowed).toBe(false);
    expect(loaded.enabled).toBe(false);
  });

  it('round-trips both endpoints and trims text fields', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const settings: AiSettings = {
      enabled: true,
      chat: endpoint({ baseUrl: '  https://api.deepseek.com/v1 ', model: ' deepseek-chat ' }),
      embedding: endpoint({
        baseUrl: ' https://api.siliconflow.cn/v1 ',
        model: ' BAAI/bge-m3 '
      }),
      vectorSearchEnabled: true
    };
    await saveAiSettings(settings, database);
    const loaded = await loadAiSettings(database);
    expect(loaded.enabled).toBe(true);
    expect(loaded.chat.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(loaded.chat.model).toBe('deepseek-chat');
    expect(loaded.embedding.baseUrl).toBe('https://api.siliconflow.cn/v1');
    expect(loaded.embedding.model).toBe('BAAI/bge-m3');
    expect(loaded.vectorSearchEnabled).toBe(true);
  });

  it('migrates the legacy single-endpoint shape into both endpoints', async () => {
    const database = makeDb();
    await ensureSchema(database);
    await database.meta.put({
      key: 'ai_settings',
      value: JSON.stringify({
        enabled: true,
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5:7b',
        embeddingModel: 'nomic-embed-text',
        apiKey: 'k',
        remoteAllowed: false,
        remoteConsentAt: null,
        remoteConsentBaseUrl: null,
        vectorSearchEnabled: true
      }),
      updatedAt: 'x'
    });
    const loaded = await loadAiSettings(database);
    expect(loaded.chat.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(loaded.chat.model).toBe('qwen2.5:7b');
    expect(loaded.embedding.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(loaded.embedding.model).toBe('nomic-embed-text');
    expect(loaded.embedding.apiKey).toBe('k');
    expect(loaded.vectorSearchEnabled).toBe(true);
  });

  it('preserves unknown fields written by newer versions', async () => {
    const database = makeDb();
    await ensureSchema(database);
    await database.meta.put({
      key: 'ai_settings',
      value: JSON.stringify({ ...DEFAULT_AI_SETTINGS, futureFlag: 'keep-me' }),
      updatedAt: 'x'
    });
    await saveAiSettings({ ...DEFAULT_AI_SETTINGS }, database);
    const raw = (await database.meta.get('ai_settings'))?.value ?? '{}';
    expect(JSON.parse(raw).futureFlag).toBe('keep-me');
  });

  it('falls back to defaults for corrupt settings', async () => {
    const database = makeDb();
    await ensureSchema(database);
    await database.meta.put({ key: 'ai_settings', value: 'not-json', updatedAt: 'x' });
    expect(await loadAiSettings(database)).toEqual(DEFAULT_AI_SETTINGS);
  });

  it('treats invalid consent data as not allowed', () => {
    const invalid = normalizeAiSettings({
      ...DEFAULT_AI_SETTINGS,
      chat: endpoint({ remoteConsentAt: 'not-a-date' })
    });
    expect(invalid.chat.remoteAllowed).toBe(false);
    expect(invalid.chat.remoteConsentAt).toBeNull();

    const mismatched = normalizeAiSettings({
      ...DEFAULT_AI_SETTINGS,
      chat: endpoint({ remoteConsentBaseUrl: 'http://other.example.com' })
    });
    expect(mismatched.chat.remoteAllowed).toBe(false);

    const missingModel = normalizeAiSettings({
      ...DEFAULT_AI_SETTINGS,
      chat: endpoint({ model: '   ' })
    });
    expect(missingModel.chat.model).toBe(DEFAULT_CHAT_ENDPOINT.model);
    expect(DEFAULT_EMBEDDING_ENDPOINT.model).toBe('BAAI/bge-m3');
  });

  it('classifies destinations by URL and gates each endpoint independently', () => {
    expect(isLoopbackBaseUrl('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isLoopbackBaseUrl('http://localhost:8080/v1')).toBe(true);
    expect(isLoopbackBaseUrl('http://[::1]:8080/v1')).toBe(true);
    expect(isLoopbackBaseUrl('https://api.deepseek.com/v1')).toBe(false);
    expect(isValidBaseUrl('abc')).toBe(false);
    expect(isValidBaseUrl('ftp://ai.example.com')).toBe(false);

    // 默认两个远端端点都未授权
    expect(endpointBlockedReason(DEFAULT_AI_SETTINGS.chat)).toContain('未获授权');
    expect(endpointBlockedReason(DEFAULT_AI_SETTINGS.embedding)).toContain('未获授权');

    // loopback 不需要授权
    expect(
      endpointBlockedReason({ ...DEFAULT_CHAT_ENDPOINT, baseUrl: 'http://127.0.0.1:11434/v1' })
    ).toBeNull();

    // 授权绑定 origin
    expect(endpointBlockedReason(endpoint())).toBeNull();
    expect(endpointBlockedReason(endpoint({ baseUrl: 'http://other.example.com/v1' }))).toContain(
      '重新授权'
    );
    // 两个端点互相独立：chat 已授权不影响 embedding
    const mixed = normalizeAiSettings({
      ...DEFAULT_AI_SETTINGS,
      chat: endpoint()
    });
    expect(endpointBlockedReason(mixed.chat)).toBeNull();
    expect(endpointBlockedReason(mixed.embedding)).toContain('未获授权');
    expect(baseUrlOrigin('http://ai.example.com/v1')).toBe('http://ai.example.com');
  });

  it('describes what leaving the machine would send', () => {
    expect(describeRemoteSend(3, 1200)).toBe('将把 3 篇笔记（约 1200 字符）发送到远端 AI 服务。');
  });
});
