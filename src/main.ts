import { Plugin, Notice } from "obsidian";
import type { TFile } from "obsidian";
import { z } from "zod";
import { SyncEngine } from "./sync-engine";
import { SyncSettingTab } from "./settings";
import { StatusBar } from "./status";
import { SyncDatabase } from "./db";
import type { Result } from "./result";
import { type SyncSettings, DEFAULT_SETTINGS } from "./types";

const SettingsSchema = z
  .object({
    serverUrl: z.string(),
    username: z.string(),
    password: z.string(),
    dbName: z.string(),
    paused: z.boolean(),
  })
  .partial();

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
            new Notice(this.settings.paused ? "Sync paused" : "Sync resumed");
          })
          .catch((e: unknown) => {
            console.error("[SimpleSync] Failed to save settings:", e);
          });
      },
    });

    this.addCommand({
      id: "show-conflicts",
      name: "Show recent conflicts",
      callback: () => {
        const conflictFiles = this.app.vault
          .getFiles()
          .filter((f: TFile) => f.path.includes(".conflict-"))
          .sort((a: TFile, b: TFile) => b.stat.mtime - a.stat.mtime)
          .slice(0, 20);

        if (conflictFiles.length === 0) {
          new Notice("No conflict files found.");
          return;
        }

        new Notice(`${String(conflictFiles.length)} conflict file(s):\n${conflictFiles.map((f: TFile) => f.path).join("\n")}`, 10000);
      },
    });

    // Start sync if settings are configured
    if (this.settings.serverUrl !== "" && !this.settings.paused)
      // Delay start slightly to let Obsidian finish loading
      this.registerInterval(
        window.setTimeout(() => {
          this.startSync().catch((e: unknown) => {
            console.error("[SimpleSync] Failed to start sync:", e);
          });
        }, 2000),
      );
  }

  public override onunload(): void {
    this.engine?.stop();
    this.engine = null;
    this.statusBar?.destroy();
    this.statusBar = null;
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
  }

  public async loadSettings(): Promise<void> {
    const raw: unknown = await this.loadData();
    const parsed = SettingsSchema.safeParse(raw);
    const overrides = parsed.success ? parsed.data : {};
    this.settings = {
      serverUrl: overrides.serverUrl ?? DEFAULT_SETTINGS.serverUrl,
      username: overrides.username ?? DEFAULT_SETTINGS.username,
      password: overrides.password ?? DEFAULT_SETTINGS.password,
      dbName: overrides.dbName ?? DEFAULT_SETTINGS.dbName,
      paused: overrides.paused ?? DEFAULT_SETTINGS.paused,
    };
  }

  public async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Start or restart sync. Debounced to avoid rapid restarts from settings changes. */
  public restartSync(): void {
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startSync().catch((e: unknown) => {
        console.error("[SimpleSync] Failed to start sync:", e);
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

    this.engine = new SyncEngine(this.app, this.settings);
    this.engine.onStatusChange((status, detail) => {
      this.statusBar?.update(status, detail);
    });
    this.statusBar?.update("initial-sync");
    const result = await this.engine.start();
    if (!result.ok) {
      const reason = result.error instanceof Error ? result.error.message : String(result.error);
      console.error("[SimpleSync] Failed to start sync:", result.error);
      new Notice(`Sync failed: ${reason}`);
      this.statusBar?.update("error", reason);
    }
  }

  public async testConnection(): Promise<Result<void>> {
    if (this.settings.serverUrl === "") {
      new Notice("Please enter a server URL first.");
      return { ok: false, error: new Error("No server URL") };
    }
    return SyncDatabase.testConnection(this.settings);
  }
}
