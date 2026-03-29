import { type App, type Plugin, PluginSettingTab, Setting, Notice } from 'obsidian';
import type { SyncSettings } from './types';

/** Generic plugin interface so settings.ts doesn't depend on main.ts */
interface SyncPlugin {
  app: App;
  settings: SyncSettings;
  saveSettings: () => Promise<void>;
  restartSync: () => void;
  testConnection: () => Promise<boolean>;
}

export class SyncSettingTab extends PluginSettingTab {
  public readonly plugin: SyncPlugin;

  public constructor(app: App, plugin: SyncPlugin) {
    super(app, plugin as unknown as Plugin);
    this.plugin = plugin;
  }

  public display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Simple Sync Settings' });

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('CouchDB server URL')
      .addText((text) =>
        text
          .setPlaceholder('https://your-server:5984')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
            this.plugin.restartSync();
          }),
      );

    new Setting(containerEl)
      .setName('Username')
      .setDesc('CouchDB username')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.username)
          .onChange(async (value) => {
            this.plugin.settings.username = value;
            await this.plugin.saveSettings();
            this.plugin.restartSync();
          }),
      );

    new Setting(containerEl)
      .setName('Password')
      .setDesc('CouchDB password')
      .addText((text) => {
        text
          .setValue(this.plugin.settings.password)
          .onChange(async (value) => {
            this.plugin.settings.password = value;
            await this.plugin.saveSettings();
            this.plugin.restartSync();
          });
        text.inputEl.type = 'password';
      });

    new Setting(containerEl)
      .setName('Database Name')
      .setDesc('Name of the CouchDB database')
      .addText((text) =>
        text
          .setPlaceholder('obsidian-sync')
          .setValue(this.plugin.settings.dbName)
          .onChange(async (value) => {
            this.plugin.settings.dbName = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Test Connection')
      .setDesc('Verify the server is reachable')
      .addButton((button) =>
        button.setButtonText('Test').onClick(async () => {
          new Notice('Testing...');
          const ok = await this.plugin.testConnection();
          new Notice(ok ? 'Connection successful!' : 'Connection failed');
        }),
      );

    new Setting(containerEl)
      .setName('Pause Sync')
      .setDesc('Temporarily stop syncing')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.paused).onChange(async (value) => {
          this.plugin.settings.paused = value;
          await this.plugin.saveSettings();
          this.plugin.restartSync();
        }),
      );
  }
}
