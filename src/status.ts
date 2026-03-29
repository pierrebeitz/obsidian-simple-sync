import { Plugin } from 'obsidian';
import type { SyncStatus } from './types';

const STATUS_TEXT: Record<SyncStatus, string> = {
  'idle': 'Sync: Idle',
  'syncing': 'Sync: Syncing...',
  'synced': 'Sync: Up to date',
  'offline': 'Sync: Offline',
  'error': 'Sync: Error',
  'initial-sync': 'Sync: Initial sync...',
};

export class StatusBar {
  private statusBarEl: HTMLElement | null = null;

  constructor(plugin: Plugin) {
    this.statusBarEl = plugin.addStatusBarItem();
  }

  /** Update the status bar text based on sync status */
  update(status: SyncStatus): void {
    if (this.statusBarEl) {
      this.statusBarEl.textContent = STATUS_TEXT[status];
    }
  }

  /** Clean up */
  destroy(): void {
    if (this.statusBarEl) {
      this.statusBarEl.remove();
      this.statusBarEl = null;
    }
  }
}
