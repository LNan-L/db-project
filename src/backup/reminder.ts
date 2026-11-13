/**
 * @req REQ-605 — 超过 7 天未导出提醒；不宣称后台自动备份。
 */
export const BACKUP_REMINDER_DAYS = 7;

export function needsBackupReminder(
  lastExportAt: string | null,
  now: Date = new Date()
): boolean {
  if (!lastExportAt) return true;
  const timestamp = Date.parse(lastExportAt);
  if (Number.isNaN(timestamp)) return true;
  return now.getTime() - timestamp > BACKUP_REMINDER_DAYS * 24 * 60 * 60 * 1000;
}
