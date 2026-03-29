import { type App, type Plugin, PluginSettingTab, Setting, Notice } from "obsidian";
import type { Result } from "./result";
import type { SyncSettings } from "./types";

interface HasSyncSettings {
  settings: SyncSettings;
  saveSettings: () => Promise<void>;
  restartSync: () => void;
  testConnection: () => Promise<Result<void>>;
}

/**
 * Parses a CouchDB connection URL into its components.
 * Accepts: https://user:pass@host:port/dbname
 */
function parseConnectionUrl(raw: string): { serverUrl: string; username: string; password: string; dbName: string } | null {
  try {
    const url = new URL(raw);
    const dbName = url.pathname.replace(/^\//, "");
    if (dbName === "") return null;

    // Rebuild server URL without credentials and db path
    const serverUrl = `${url.protocol}//${url.host}`;
    return {
      serverUrl,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      dbName,
    };
  } catch {
    return null;
  }
}

function buildConnectionUrl(settings: SyncSettings): string {
  if (settings.serverUrl === "") return "";
  try {
    const url = new URL(settings.serverUrl);
    if (settings.username !== "") url.username = settings.username;
    if (settings.password !== "") url.password = settings.password;
    return `${url.protocol}//${url.username !== "" ? `${url.username}:${url.password}@` : ""}${url.host}/${settings.dbName}`;
  } catch {
    return "";
  }
}

export class SyncSettingTab extends PluginSettingTab {
  public readonly syncPlugin: HasSyncSettings;

  public constructor(app: App, plugin: Plugin & HasSyncSettings) {
    super(app, plugin);
    this.syncPlugin = plugin;
  }

  public display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Connection URL")
      .setDesc("Paste a full URL to auto-fill all fields below")
      .addText((text) =>
        text
          .setPlaceholder("https://admin:password@your-server:5984/obsidian-sync")
          .setValue(buildConnectionUrl(this.syncPlugin.settings))
          .onChange(async (value) => {
            const parsed = parseConnectionUrl(value);
            if (parsed === null) return;

            this.syncPlugin.settings.serverUrl = parsed.serverUrl;
            this.syncPlugin.settings.username = parsed.username;
            this.syncPlugin.settings.password = parsed.password;
            this.syncPlugin.settings.dbName = parsed.dbName;
            await this.syncPlugin.saveSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Address of your CouchDB server")
      .addText((text) =>
        text
          .setPlaceholder("https://your-server:5984")
          .setValue(this.syncPlugin.settings.serverUrl)
          .onChange(async (value) => {
            this.syncPlugin.settings.serverUrl = value;
            await this.syncPlugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Username")
      .setDesc("Username for CouchDB authentication")
      .addText((text) =>
        text.setValue(this.syncPlugin.settings.username).onChange(async (value) => {
          this.syncPlugin.settings.username = value;
          await this.syncPlugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Password")
      .setDesc("Password for CouchDB authentication")
      .addText((text) => {
        text.setValue(this.syncPlugin.settings.password).onChange(async (value) => {
          this.syncPlugin.settings.password = value;
          await this.syncPlugin.saveSettings();
        });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Database name")
      .setDesc("Database on your CouchDB server")
      .addText((text) =>
        text
          .setPlaceholder("obsidian-sync")
          .setValue(this.syncPlugin.settings.dbName)
          .onChange(async (value) => {
            this.syncPlugin.settings.dbName = value;
            await this.syncPlugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify the server and database are accessible")
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          new Notice("Testing connection...");
          const result = await this.syncPlugin.testConnection();
          if (result.ok) new Notice("Connection successful!");
          else new Notice(result.error instanceof Error ? result.error.message : String(result.error), 8000);
        }),
      );

    new Setting(containerEl)
      .setName("Pause sync")
      .setDesc("Temporarily stop syncing")
      .addToggle((toggle) =>
        toggle.setValue(this.syncPlugin.settings.paused).onChange(async (value) => {
          this.syncPlugin.settings.paused = value;
          await this.syncPlugin.saveSettings();
          this.syncPlugin.restartSync();
        }),
      );
  }

  public override hide(): void {
    this.syncPlugin.restartSync();
  }
}
