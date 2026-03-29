import { Plugin, Notice } from "obsidian";
import { SyncEngine } from "./sync-engine";
import { SyncSettingTab } from "./settings";
import { StatusBar } from "./status";
import { SyncDatabase } from "./db";
import { type SyncSettings, DEFAULT_SETTINGS } from "./types";

export default class SimpleSyncPlugin extends Plugin {
  public settings: SyncSettings = DEFAULT_SETTINGS;
  private engine: SyncEngine | null = null;
  private statusBar: StatusBar | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  public override async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBar = new StatusBar(this);

    this.addSettingTab(new SyncSettingTab(this.app, this));

    this.addCommand({
      id: "force-sync",
      name: "Force sync now",
      callback: () => {
        this.restartSync();
      },
    });

    this.addCommand({
      id: "toggle-pause",
      name: "Toggle sync pause",
      callback: () => {
        this.settings.paused = !this.settings.paused;
        this.saveSettings()
          .then(() => {
            this.restartSync();
            new Notice(
              this.settings.paused ? "Sync paused" : "Sync resumed",
            );
          })
          .catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.error("[SimpleSync] Failed to save settings:", err);
          });
      },
    });

    // Start sync if settings are configured
    if (this.settings.serverUrl !== "" && !this.settings.paused) {
      // Delay start slightly to let Obsidian finish loading
      this.registerInterval(
        window.setTimeout(() => {
          this.startSync().catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.error("[SimpleSync] Failed to start sync:", err);
          });
        }, 2000),
      );
    }
  }

  public override onunload(): void {
    this.engine?.stop();
    this.engine = null;
    this.statusBar?.destroy();
    this.statusBar = null;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
    }
  }

  public async loadSettings(): Promise<void> {
    const raw: unknown = await this.loadData();
    const loaded =
      typeof raw === "object" && raw !== null
        ? (raw as Partial<SyncSettings>)
        : {};
    this.settings = { ...DEFAULT_SETTINGS, ...loaded };
  }

  public async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Start or restart sync. Debounced to avoid rapid restarts from settings changes. */
  public restartSync(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startSync().catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[SimpleSync] Failed to start sync:", err);
      });
    }, 500);
  }

  private async startSync(): Promise<void> {
    // Stop existing engine
    this.engine?.stop();
    this.engine = null;

    if (this.settings.serverUrl === "" || this.settings.paused) {
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
      // eslint-disable-next-line no-console
      console.error("[SimpleSync] Failed to start sync:", err);
      new Notice("Sync failed to start. Check your settings.");
      this.statusBar?.update("error");
    }
  }

  public async testConnection(): Promise<boolean> {
    if (this.settings.serverUrl === "") {
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
