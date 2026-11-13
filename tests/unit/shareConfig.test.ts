import { describe, expect, it } from 'vitest';
import { buildSyncLink, parseSyncLink } from '../../src/sync/shareConfig';

const config = { serverUrl: 'https://pke.example.test', token: 'x'.repeat(64) };

describe('sync config sharing', () => {
  it('round-trips address and token through a url hash', () => {
    const link = buildSyncLink('https://pke.example.test/', config);
    expect(link.startsWith('https://pke.example.test/#sync=')).toBe(true);

    const hash = link.slice(link.indexOf('#'));
    expect(parseSyncLink(hash)).toEqual({ u: config.serverUrl, t: config.token });
  });

  it('rejects malformed or incomplete payloads', () => {
    expect(parseSyncLink('')).toBeNull();
    expect(parseSyncLink('#other=1')).toBeNull();
    expect(parseSyncLink('#sync=not-base64!!')).toBeNull();
    const shortToken = buildSyncLink('', { serverUrl: 'https://a.test', token: 'short' });
    expect(parseSyncLink(shortToken)).toBeNull();
  });
});