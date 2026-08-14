// 실시간 로그 출력 헬퍼

import { LogLevel, SyncLog } from './types';

export class SyncLogger {
  private logs: SyncLog[] = [];
  private onLog?: (log: SyncLog) => void;

  constructor(onLog?: (log: SyncLog) => void) {
    this.onLog = onLog;
  }

  private createLog(level: LogLevel, message: string): SyncLog {
    const now = new Date();
    const timestamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    const log: SyncLog = {
      timestamp,
      level,
      message,
    };

    this.logs.push(log);
    this.onLog?.(log);
    return log;
  }

  info(message: string) {
    return this.createLog('info', `→ ${message}`);
  }

  success(message: string) {
    return this.createLog('success', `✓ ${message}`);
  }

  warning(message: string) {
    return this.createLog('warning', `⚠ ${message}`);
  }

  error(message: string) {
    return this.createLog('error', `✗ ${message}`);
  }

  getLogs(): SyncLog[] {
    return [...this.logs];
  }

  clear() {
    this.logs = [];
  }
}
