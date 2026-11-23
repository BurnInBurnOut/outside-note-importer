# Outside Note Importer

Import Markdown files you open from outside your vault, like ones in Downloads, into a vault folder so they show up in search and links.

## Why

Since 1.14.4, Obsidian can open a Markdown file from Finder or Explorer even when it isn't in your vault. It shows up in a tab, but it's never indexed: it isn't in search, links, or the file list. Once you close the tab, the file is back in Downloads and easy to lose track of.

This plugin catches that moment and offers to bring the note into your vault.

## What it does

When a note from outside your vault opens, you get a prompt:

- **Name**: pre-filled from the file; rename it here if you want.
- **Folder**: type to pick any vault folder. A new name creates the folder.
- **Import**: copies the note into your vault, switches the open tab to the vault copy, and moves the original to your system Trash, where you can still recover it.
- **Not now**: won't ask again about that file until you restart Obsidian.
- **Never ask for ~/Some/Folder**: adds that folder to an ignore list.

While an outside note is the active tab, the status bar shows **Outside vault · Import**. Click it to reopen the prompt. You can also use **Import into vault…** in the tab's right-click menu, or the command **Outside Note Importer: Import this note into the vault**, which you can give a hotkey.

## Settings

| Setting | Default |
|---|---|
| When a note from outside the vault opens | Ask me (or Import automatically, or Do nothing) |
| Default folder | Empty, which uses Obsidian's "Default location for new notes" |
| Remember the last folder I picked | On |
| After importing | Move the original to the Trash (or leave it where it is) |
| Skip notes that belong to another vault | On |
| Never ask about these folders | Empty; one folder per line, `~` allowed |

## Files outside your vault

This plugin reads and moves files outside your vault, which is its whole purpose. It only touches a file that you have opened in Obsidian yourself:

- **Reads** the outside file so it can copy it into your vault.
- **Moves the original to the system Trash** after a successful import. You can turn this off in settings ("Leave the original where it is").
- **Checks parent folders** of the outside file for an Obsidian config folder, so it can skip notes that belong to another vault.

It never deletes anything permanently, never scans your disk, and makes no network requests.

## Install

**From Obsidian:** Settings → Community plugins → Browse → search "Outside Note Importer". This works once the plugin is listed in the directory.

**With BRAT (before it's listed):** install the [BRAT](https://community.obsidian.md/plugins/obsidian42-brat) plugin, open its settings, choose **Add beta plugin**, and paste this repository's URL.

**Manually:** download `main.js`, `manifest.json` and `styles.css` from the latest [release](../../releases/latest). Put them in `<your vault>/.obsidian/plugins/outside-note-importer/`, then enable the plugin under Settings → Community plugins. On macOS, press ⌘⇧. in Finder to see the hidden `.obsidian` folder.

Requires Obsidian 1.14.4 or later. Desktop only.

## Notes and limits

- Name clashes follow Obsidian's own scheme: `Note.md`, then `Note 1.md`. Nothing is ever overwritten.
- If you edited the outside note in Obsidian before importing, the import keeps those edits.
- Only Markdown files trigger the prompt automatically. The command and menu item work for any outside file.
- Images linked with relative paths next to the original (`./img.png`) aren't copied yet.

## Development

```sh
npm install
npm run build   # type-check and bundle to main.js
npm run lint    # Obsidian's own review rules (eslint-plugin-obsidianmd)
npm test        # end-to-end tests against a mocked Obsidian
```

To release: bump `version` in `manifest.json` and `package.json`, and add the version to `versions.json`. Then go to **Actions → Release Obsidian plugin → Run workflow** on GitHub. The workflow lints, tests, builds, signs the files with an artifact attestation, and publishes the release.

## License

[MIT](LICENSE)
