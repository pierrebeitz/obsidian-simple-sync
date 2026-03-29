import { Plugin, Notice } from "obsidian";
import { SyncEngine } from "./sync-engine";
import { SyncSettingTab } from "./settings";
import { StatusBar } from "./status";
import { SyncDatabase } from "./db";
import { SyncSettings, DEFAULT_SETTINGS } from "./types";

export default class SimpleSyncPlugin extends Plugin {
  settings: SyncSettings = DEFAULT_SETTINGS;
  private engine: SyncEngine | null = null;
  private statusBar: StatusBar | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  async onload() {
    await this.loadSettings();

    this.statusBar = new StatusBar(this);

    this.addSettingTab(new SyncSettingTab(this.app, this));

    this.addCommand({
      id: "force-sync",
      name: "Force sync now",
      callback: () => this.restartSync(),
    });

    this.addCommand({
      id: "toggle-pause",
      name: "Toggle sync pause",
      callback: async () => {
        this.settings.paused = !this.settings.paused;
        await this.saveSettings();
        await this.restartSync();
        new Notice(
          this.settings.paused ? "Sync paused" : "Sync resumed",
        );
      },
    });

    // Start sync if settings are configured
    if (this.settings.serverUrl && !this.settings.paused) {
      // Delay start slightly to let Obsidian finish loading
      this.registerInterval(
        window.setTimeout(() => this.startSync(), 2000),
      );
    }
  }

  onunload() {
    this.engine?.stop();
    this.engine = null;
    this.statusBar?.destroy();
    this.statusBar = null;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData(),
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Start or restart sync. Debounced to avoid rapid restarts from settings changes. */
  async restartSync() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startSync();
    }, 500);
  }

  private async startSync() {
    // Stop existing engine
    this.engine?.stop();
    this.engine = null;

    if (!this.settings.serverUrl || this.settings.paused) {
      this.statusBar?.update("idle");
      return;
    }

    try {
      this.engine = new SyncEngine(this.app, this.settings);
      this.engine.onStatusChange((status) => {
        this.statusBar?.update(status);
      });
      this.statusBar?.update("initial-sync");
      await this.engine.start();
    } catch (err) {
      console.error("[SimpleSync] Failed to start sync:", err);
      new Notice("Sync failed to start. Check your settings.");
      this.statusBar?.update("error");
    }
  }

  async testConnection(): Promise<boolean> {
    if (!this.settings.serverUrl) {
      new Notice("Please enter a server URL first.");
      return false;
    }
    const db = new SyncDatabase("simple-sync-test");
    try {
      return await db.testConnection(this.settings);
    } finally {
      await db.destroy();
    }
  }
}
