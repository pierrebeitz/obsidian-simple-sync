import { type App, type Plugin, PluginSettingTab, Setting, Notice } from "obsidian";
import type { Result } from "./result";
import type { SyncSettings } from "./types";

interface HasSyncSettings {
  settings: SyncSettings;
  saveSettings: () => Promise<void>;
  restartSync: () => void;
  testConnection: () => Promise<Result<void>>;
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

    containerEl.createEl("h2", { text: "Simple Sync Settings" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("CouchDB server URL")
      .addText((text) =>
        text
          .setPlaceholder("https://your-server:5984")
          .setValue(this.syncPlugin.settings.serverUrl)
          .onChange(async (value) => {
            this.syncPlugin.settings.serverUrl = value;
            await this.syncPlugin.saveSettings();
            this.syncPlugin.restartSync();
          }),
      );

    new Setting(containerEl)
      .setName("Username")
      .setDesc("CouchDB username")
      .addText((text) =>
        text.setValue(this.syncPlugin.settings.username).onChange(async (value) => {
          this.syncPlugin.settings.username = value;
          await this.syncPlugin.saveSettings();
          this.syncPlugin.restartSync();
        }),
      );

    new Setting(containerEl)
      .setName("Password")
      .setDesc("CouchDB password")
      .addText((text) => {
        text.setValue(this.syncPlugin.settings.password).onChange(async (value) => {
          this.syncPlugin.settings.password = value;
          await this.syncPlugin.saveSettings();
          this.syncPlugin.restartSync();
        });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Database Name")
      .setDesc("Name of the CouchDB database")
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
      .setName("Test Connection")
      .setDesc("Verify the server and database are accessible")
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          new Notice("Testing connection...");
          const result = await this.syncPlugin.testConnection();
          if (result.ok) new Notice("Connection successful!");
          else new Notice(String(result.error), 8000);
        }),
      );

    new Setting(containerEl)
      .setName("Pause Sync")
      .setDesc("Temporarily stop syncing")
      .addToggle((toggle) =>
        toggle.setValue(this.syncPlugin.settings.paused).onChange(async (value) => {
          this.syncPlugin.settings.paused = value;
          await this.syncPlugin.saveSettings();
          this.syncPlugin.restartSync();
        }),
      );
  }
}
