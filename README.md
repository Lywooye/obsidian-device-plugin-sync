# Device Selective Sync

English · [简体中文](README.zh-CN.md)

Choose which Obsidian plugins can sync on your computers, phone, and iPad. Manage all devices from one computer, or choose plugins for your phone or iPad on that device.

This plugin is free under the [MIT license](LICENSE). It requires an **Obsidian account and a paid Obsidian Sync subscription**; it uses the official Sync service already configured for your vault. It is an independent community project, not an official Obsidian product. Version **0.3.1 is experimental**: it supports Obsidian 1.13.7 only when the device passes compatibility checks. Real phone and iPad sync has not yet been validated. Start with a test vault.

[Repository](https://github.com/Lywooye/obsidian-device-plugin-sync) · [Releases](https://github.com/Lywooye/obsidian-device-plugin-sync/releases)

The public name is **Device Selective Sync**, previously Device Plugin Sync. The ID remains `device-plugin-sync`. Existing `Device Plugin Sync/Policy.md`, `Device Plugin Sync/Installations/`, and local settings keep their original paths and keys; no migration or reset is needed.

## What the checkboxes mean

- **Checked: allow this plugin to sync on this device.** Other Sync settings still apply.
- **Unchecked: block uploads and downloads of this plugin's files on this device.** An installed plugin stays in place unless you separately confirm cleanup.

When creating the list, computers start with every plugin selected; phones and iPads start with none selected. Each device has “Select all” and “Select none” buttons. Updating this plugin does not reset saved choices. Version 0.3.0 can also add new plugins and set their sync scope based on **which device installed them**, as described below.

## Getting started

### On your managing computer

1. Install and enable this plugin, then open **Settings → Device Selective Sync**.
2. Click **Create sync list**. This computer manages the device names and plugin list.
3. Click **Choose plugins for devices**, make your selections, then click **Save list**.
4. Select the entry that represents this computer.
5. Click **Review and apply**, check this device's changes, then click **Apply changes**. **Manual changes to existing plugins still need to be applied on each device.**
6. After a successful application, you can choose whether to remove excluded plugins from this device. Cleanup is optional.

### On your phone or iPad

1. Wait for this plugin, the list, and installation records in `Device Plugin Sync/` to finish syncing, then enable this plugin on the mobile device.
2. Open its settings and refresh. Select the entry for this phone or iPad. Different devices should use different entries.
3. Check compatibility. The experimental mobile option is available only if all checks pass on that device.
4. Click **Choose this device’s plugins** and select the plugins you want. It includes all plugins registered in the shared list, even if they have not downloaded to the phone.
5. Save and apply, review the preview, then confirm.
6. Wait for Sync to finish before editing on another device.

If the old interface is still visible after an update, disable and re-enable Device Selective Sync only. A newer version of the shared table does not mean its choices have been applied on this device; check the local result.

For initial setup, you can pause official Sync, apply the choices on the current device, then resume it. Pausing does not undo a transfer that has already started or prevent other plugins from downloading before this plugin is installed.

## Set sync choices automatically for new installations

**Set sync defaults for new plugins automatically** is on by default. The switch applies only to this device. It recognizes **new installations made through Obsidian’s official community-plugin interface while Device Selective Sync is running**. It adds each new plugin to the shared list, and devices that receive it adjust sync settings for that new plugin only.

| Where the new plugin was installed | All computers | The phone or iPad that installed it | Other phones and iPads |
| --- | --- | --- | --- |
| Computer | Allow sync | Not applicable | Block sync |
| Phone or iPad | Allow sync | Allow sync | Block sync |

For example, installing a new plugin on your phone also allows computers to receive it, while other phones and iPads exclude it by default. You can change that later in the selection table. **These defaults do not reset existing plugins, your manual choices, or choices when a plugin is updated.**

Upgrade computers, phones, and iPads to this plugin version 0.3.0 or later; older versions do not handle new plugins automatically. Set up each device first:

1. Choose the entry representing this device and keep Device Selective Sync enabled.
2. Enable **Set sync defaults for new plugins automatically**.
3. Enable community-plugin file and plugin-settings synchronization in official Sync. Let both `Device Plugin Sync/Policy.md` and `Device Plugin Sync/Installations/` sync normally.
4. Pass compatibility checks. Each phone and iPad also needs **Allow sync changes on this phone or tablet (experimental)** enabled locally.

The plugin checks when files change and periodically. When the requirements are met, it automatically applies only **plugin IDs not previously registered on this device**. It does not also apply manual changes to existing plugins, open cleanup prompts, remove files, or modify the enabled-plugin list. Allowing a new plugin to sync does not enable it.

**After upgrading, or when this device first receives the shared list, the existing IDs are recorded as a starting point. Old choices are not applied for you.** Use **Review and apply** for any choices that have not yet been applied. Turning automatic handling off leaves manual selection, saving, and applying available.

Installations through BRAT or manual copying cannot reliably reveal their source. The same applies when Device Selective Sync was not running, automatic handling was off, or no shared list or device assignment existed yet. Set up the list and device first. Turn automatic defaults back on, click **Register local installs**, select unregistered plugins, then click **Confirm these were installed here**. Do not register a plugin just received through Sync as a local installation. Registration does not overwrite a plugin already in the shared list.

If the device is unassigned, compatibility checks fail, the mobile experimental option is off, or files cannot be read or written, the interface explains what it is waiting for. Address the cause, then click **Check new plugins** to retry. The plugin does not bypass these checks to force a write.

Automatic handling still runs **after information arrives**. Plugin files, installation records, and the shared list can arrive in different orders. This cannot guarantee that an unwanted plugin is never downloaded, or recall an in-flight transfer. Files already downloaded stay in place unless you later confirm cleanup.

Installation-source records are stored at:

```text
Device Plugin Sync/Installations/<source installation ID>/<plugin ID>.md
```

Separate paths reduce different installations overwriting each other’s records. Devices read the records and add only plugin IDs not yet present in `Policy.md`. This is not a cross-device lock. Existing choices for an ID take priority, and simultaneous offline edits can still conflict. Continue to avoid manually editing the list on multiple devices at once.

No new plugin was installed on a real device to validate this automatic workflow during this update. Project tests and interface checks do not replace phone, iPad, and network sync tests.

## Optional cleanup after applying

After you manually apply choices, this plugin offers to clean up plugins that are **installed here but excluded from syncing on this device**. Click **Keep local plugins** to skip. To continue, select individual plugins, confirm that their local settings will also move, then click **Remove selected plugins (keep backup)**. No plugins are selected by default.

Cleanup moves the whole plugin folder, including its program files and settings such as `data.json`. Check whether you need those settings before continuing. Device Selective Sync never includes itself in the cleanup list.

Cleanup **keeps a backup instead of permanently deleting files**. It does not free the disk space occupied by those files. Folders move into this vault's hidden directory:

```text
.device-plugin-sync-trash/<cleanup batch ID>/<plugin ID>/
```

Before cleanup, **pause official Sync and wait for current transfers to finish**. If the cleanup window blocks access to settings, click **Keep local plugins**, pause Sync in its settings, then return to this plugin and click **Choose plugins to remove**. This reduces the risk of an in-flight sync interpreting the local cleanup as a deletion. This plugin does not pause or resume Sync for you. Check the result before resuming. Selected running plugins are stopped locally; other plugins are left alone, and the shared enabled-plugin list is not rewritten.

To retrieve a backup, click **View local backups** under **Restore removed plugin files**, find the plugin, then click **Restore this plugin**. Pause Sync and wait for transfers to finish again. The plugin must still be excluded from syncing here. If you have allowed it to sync again, first uncheck it and apply the change. Retrieval moves the backup to its original location only when that folder is absent. It never overwrites existing files, removes the Sync exclusion, or enables the plugin automatically. The retrieval action itself does not enable the plugin. However, because the original enabled-plugin list remains unchanged, **a previously enabled plugin may load again after restarting Obsidian**. Check Community plugins and verify the restored files and settings before deciding whether to enable it or allow it to sync.

Before cleanup or retrieval, this plugin checks that the original folder is excluded, the backup location cannot sync, and the required interfaces are compatible. It stops if any check fails. Cleanup has two additional internal-function checks. If cleanup is unsupported, you can still apply sync choices as long as the separate Sync checks pass. Do not rename the backup directory, sync it with another tool, or manually include it in synchronization.

If an error interrupts the operation, some plugins may already have moved, or files may have moved before Obsidian refreshed its list. Review completed and unconfirmed items, then check **View local backups**. An error does not necessarily mean nothing changed. Restart Obsidian if needed to refresh the plugin list, then check the result before resuming Sync.

**Stopping sync and removing files are separate actions.** Applying your choices alone does not delete files. Cleanup does not change other devices' choices in the shared table.

This is a local operation. A success message is not proof that remote files or other devices have been checked. The plugin cannot undo previous sync changes or recall transfers that have already started.

## Allowing sync again, retrieving backups, and troubleshooting

| Action | When to use it | What it does |
| --- | --- | --- |
| Allow these plugins to sync again | You want to undo the restrictions this plugin set on this device, or stop using it | Previews and removes only the restrictions this plugin added. Your existing restrictions stay. It does not retrieve removed files or restore old settings. |
| View local backups → Restore this plugin | You want a plugin and its settings back after cleanup | While Sync is paused and the plugin is still excluded, moves its local backup into the empty original location. Does not overwrite files, explicitly enable the plugin, or resume sync. A previously enabled plugin may load again after a restart. |
| Check last operation | An application failed, the app crashed, or an unfinished operation is reported | Compares current Sync settings with the recorded operation and repairs this plugin's record when possible. It does not apply choices again or change Sync settings. Preview again afterward. |
| Reset this plugin’s records | Records cannot be recovered and you accept handling remaining restrictions manually | **Clears records only; existing Sync restrictions stay.** This plugin will no longer know which ones it added. Most users should never need this. |

Allowing sync again may download remote files, update a local plugin, or process remote deletions. It does not mean “return to how things were before cleanup.” File retrieval is a separate action.

**Disabling or uninstalling Device Selective Sync does not automatically remove the Sync restrictions it has already set.** If you want to remove them, use **Allow these plugins to sync again** and check the result before disabling this plugin.

**Troubleshooting (usually not needed)** stays collapsed during normal use.

If the current settings match neither the recorded “before” nor “after” state, the plugin asks you to inspect official Sync settings. It does not guess or overwrite them. Clearing Obsidian's local data, reinstalling the device, or reconfiguring the vault may also remove this plugin's tracking records.

## Chinese and English

The interface supports Simplified Chinese and English. Select **Follow Obsidian / 简体中文 / English** in this plugin's settings. The choice applies only to this device.

Follow Obsidian uses Obsidian's interface language: Chinese uses Simplified Chinese, and other languages use English. New installations follow Obsidian. Upgrading users keep Chinese and can change it at any time.

This is the English guide; the Chinese guide is [README.zh-CN.md](README.zh-CN.md). Plugin names, plugin IDs, your device names, and paths are not translated.

## Limits to understand

### This plugin manages plugin-file synchronization

It adds or removes Sync restrictions for individual plugin folders. The default path is `.obsidian/plugins/<plugin ID>`. If a device uses a custom configuration folder, its actual folder is used.

- Before you confirm cleanup, existing plugin files, settings, and enabled states are left alone.
- This plugin does not install or update plugins.
- It does not manage synchronization of the enabled community-plugin list. Whether a plugin's files sync and whether the plugin is enabled are separate settings.
- Checking a plugin does not force a download or override other restrictions. If you already exclude the entire plugins folder, checking one plugin does not remove that restriction.
- Manual changes to existing plugins still require refresh, preview, and confirmation. When automatic handling is enabled, only newly registered plugin IDs are applied automatically; old choices are not applied retroactively.

To transfer allowed plugins and their settings, enable community-plugin file and plugin-settings synchronization in official Sync. Configure enabled-plugin list synchronization separately; automatic handling does not rewrite that list.

### The phone reads the shared list, not the computer’s disk

Shared choices live in the ordinary note `Device Plugin Sync/Policy.md`. New installation-source records live under `Device Plugin Sync/Installations/`. Let both sync normally; do not exclude them or their parent folder.

The list contains device names and identifiers, plugin names and IDs, and each device’s choices. Installation records also identify the source. Neither contains cleanup backups. The current device selection, operation records, compatibility confirmation, and language preference stay local.

The managing computer can manually maintain every device and the plugin catalog. Phones and iPads manually edit only their assigned entry. Recognized new installations are registered automatically. Unrecognized ones require confirmation of their source, or reopening and saving the selection table on the managing computer. The phone displays the shared list it has received; it does not read the computer’s disk live.

### Avoid editing on two devices at once

Wait for Sync to finish before editing. After saving, wait again before switching devices.

Saving detects changes that have **already arrived on this device** and asks you to reopen the editor. It cannot lock another offline device or guarantee that simultaneous edits will not conflict. After a conflict, review the merged shared choices, then preview and apply them on each device.

Saving choices on mobile and changing local Sync settings are separate steps. If saving succeeds but applying fails, the plugin reports that the choices were saved but were not applied locally. Follow the unfinished-operation instructions, then preview again. Other devices do not automatically apply changed choices for existing plugins. Only newly registered plugins use the automatic workflow described above.

### Why an Obsidian update may block applying changes

Obsidian has no public Sync API for the operation this plugin needs, so this version uses internal interfaces. Those may change after an upgrade, or differ between platforms even with the same displayed version number.

The plugin checks the version, fingerprints of 12 internal methods, and file-filter behavior. A mismatch blocks changes to Sync settings. You can still view choices and previews. **Official Sync itself is not paused by this protection.** Saved restrictions continue to be handled by Sync; new choices have not taken effect.

Recognizing installations from the official community-plugin interface has a separate compatibility check for the installation method. If it fails, the plugin must not guess the source. Automatic handling and manual application both respect the Sync compatibility checks.

Supporting another version requires checking its actual implementation and behavior. Changing a version number or bypassing a check is not sufficient. Mobile devices showing 1.13.7 must still pass their own checks and have the experimental option enabled locally.

Current testing does not replace real phone/iPad tests, network synchronization tests, restart persistence checks, or checks of in-flight transfers. See the [validation record](docs/test-results.md) and [device validation guide](docs/device-validation.md) for evidence and remaining checks. These technical documents are currently in Chinese.

### Data handling and internal interfaces

The plugin makes no direct external network requests and has no telemetry, analytics, or its own upload service. Obsidian Sync transfers your plugin files, settings, shared choices, and installation records using your existing account and vault configuration. No files outside the current vault are accessed by the runtime plugin.

Plugin folders can include `data.json` or other settings files containing API keys or credentials saved by other plugins. If you allow such a folder to sync, its settings may be transferred by Obsidian Sync as part of that existing feature. This plugin does not redact credentials or separate program files from settings. Cleanup backups also retain the entire settings folder locally.

For reviewers: the runtime uses private Sync methods to read and save exclusions, a private plugin-manager method to stop a plugin during confirmed cleanup, and a temporary wrapper around the private community-plugin installation method to observe new installations. The wrapper is removed on unload only if it is still this plugin’s wrapper. There is no claim that these interfaces are supported by Obsidian or stable across updates. Exact-version and method-fingerprint checks block affected features when they do not match; they are compatibility checks, not a security boundary against other plugins.

Native-source tests read a developer’s locally installed desktop Obsidian build into memory and use isolated test objects. The repository and release assets include fingerprints and test tools, **not Obsidian’s native source, application bundle, or extracted native fixtures**. Those native tests require access to a compatible local build and do not establish mobile or network correctness.

## Manual installation

Community-directory approval is still pending; do not assume it is available in Obsidian’s built-in browser. Download the runtime files or installation ZIP from [GitHub Releases](https://github.com/Lywooye/obsidian-device-plugin-sync/releases), or build the ZIP in `dist`:

1. Disable an existing Device Selective Sync installation first.
2. Put the three runtime files from the ZIP in the vault's actual configuration folder:

   ```text
   .obsidian/plugins/device-plugin-sync/
   ├── main.js
   ├── manifest.json
   └── styles.css
   ```

3. Replace `.obsidian` with your actual configuration folder name if customized.
4. Enable Device Selective Sync under **Settings → Community plugins** in Obsidian.

Do not nest an extra `dist` folder in this directory. Manual mobile installation requires access to the vault's actual configuration folder. Placing a ZIP among your notes does not install it, and the iOS Files app may not expose the hidden configuration folder.

If devices use the same configuration folder, official Sync can transfer this plugin from the computer; enable it separately on the mobile device. That process may also transfer other plugins, so it cannot guarantee they will be blocked before their first download. With different configuration folders, do not assume the plugin will appear automatically on another device.

## Building and future publication

Requires Node.js 22 or newer, npm, and the `zip` command. From the source directory:

```sh
npm ci
npm run package
npm run test:native
```

`package` checks types, runs tests, builds, and creates an installation archive. `test:native` performs a read-only check of the installed desktop Obsidian build. Its default macOS path is `/Applications/Obsidian.app/Contents/Resources/obsidian.asar`. To check another location:

```sh
npm run test:native -- --asar /absolute/path/to/obsidian.asar
```

The project includes compatibility fingerprints and inspection tools, not Obsidian's application files or internal source code.

The public release is prepared for [Lywooye/obsidian-device-plugin-sync](https://github.com/Lywooye/obsidian-device-plugin-sync) with the [MIT license](LICENSE), English and Chinese guides, and downloadable runtime assets. A GitHub release is separate from community-directory approval.

Current [submission instructions](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin) use the Obsidian Community website, where an Obsidian account is linked to the repository owner’s GitHub account. An old pull-request template in `obsidian-releases` is not the current submission route. The directory reviews the repository and releases; this project does not claim approval before the directory confirms it.

Real phone/iPad, network transfer, automatic-installation, cleanup/retrieval, and restart tests remain listed in [device validation](docs/device-validation.md). Test counts and their scope are recorded in [test results](docs/test-results.md). English and Chinese support improves accessibility; it is not presented as a separate official submission requirement. The [plain-language review](docs/plain-language-review.md) describes the wording changes.

## Official references

- [Sync settings](https://obsidian.md/help/sync/settings)
- [Configuration folder](https://obsidian.md/help/configuration-folder)
- [Community plugins](https://obsidian.md/help/community-plugins)
- [Obsidian TypeScript API](https://docs.obsidian.md/Reference/TypeScript+API)

These documents explain built-in features. They do not promise long-term availability of the internal interfaces used here.
