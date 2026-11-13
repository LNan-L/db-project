/**
 * @req REQ-101 — 稳定 ID；Phase 1 生产实现。
 */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `note-${Date.now()}-${random}`;
}
