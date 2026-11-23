import {
	AbstractInputSuggest,
	App,
	FileSystemAdapter,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
	TAbstractFile,
	TFile,
	TFolder,
	WorkspaceLeaf,
	normalizePath,
	setIcon,
} from "obsidian";
import * as obsidian from "obsidian";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ─── Settings ────────────────────────────────────────────────────────────────

type OpenMode = "ask" | "auto" | "off";
type OriginalMode = "trash" | "keep";

interface IntakeSettings {
	/** What happens when a note from outside the vault opens. */
	mode: OpenMode;
	/** Vault folder offered by default. Empty = Obsidian's "Default location for new notes". */
	defaultFolder: string;
	/** Pre-fill the folder field with whatever was picked last time. */
	rememberLastFolder: boolean;
	lastFolder: string;
	/** What happens to the original file after a successful import. */
	original: OriginalMode;
	/** Don't prompt for files that live inside some other Obsidian vault. */
	skipOtherVaults: boolean;
	/** Absolute folders (~ allowed), one per line, whose files never trigger the prompt. */
	ignoredFolders: string;
}

const DEFAULT_SETTINGS: IntakeSettings = {
	mode: "ask",
	defaultFolder: "",
	rememberLastFolder: true,
	lastFolder: "",
	original: "trash",
	skipOtherVaults: true,
	ignoredFolders: "",
};

function folderLines(text: string): string[] {
	return text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

const NOTE_EXTENSIONS = new Set(["md", "markdown"]);

// ─── Filesystem helpers (exported for tests) ────────────────────────────────

const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

export function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

export function tildify(p: string): string {
	const home = os.homedir();
	if (p === home) return "~";
	if (p.startsWith(home + path.sep)) return "~" + p.slice(home.length);
	return p;
}

function canonical(p: string): string {
	let out = path.resolve(p);
	try {
		out = fs.realpathSync.native(out);
	} catch {
		/* path may not exist (yet); use the resolved form */
	}
	return CASE_INSENSITIVE_FS ? out.toLowerCase() : out;
}

export function isInside(child: string, parent: string): boolean {
	const rel = path.relative(canonical(parent), canonical(child));
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * If `filePath` sits inside some Obsidian vault folder, return that folder.
 * A vault is recognized by its config folder (`configDirName`, which is the
 * current vault's `Vault#configDir`).
 */
export function owningVault(filePath: string, configDirName: string): string | null {
	let dir = path.dirname(path.resolve(filePath));
	for (;;) {
		try {
			if (fs.statSync(path.join(dir, configDirName)).isDirectory()) return dir;
		} catch {
			/* keep walking */
		}
		const up = path.dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

/** Characters Obsidian rejects in file names, plus link-breaking ones. */
export function sanitizeName(name: string): string {
	return name
		.replace(/[\\/:*?"<>|#^[\]]/g, "-")
		.replace(/\s+/g, " ")
		.trim();
}

export function cleanFolder(folder: string): string {
	const f = normalizePath(folder.trim());
	return f === "/" || f === "." ? "" : f.replace(/^\/+|\/+$/g, "");
}

// ─── External-file detection ────────────────────────────────────────────────

/**
 * Obsidian 1.14.4+ represents a file opened from outside the vault as a
 * `TExternalFile` (a TFile subclass) whose `path` looks like
 * "file:/Users/me/Downloads/note.md" and whose `getRealPath()` returns the
 * absolute path. Returns that absolute path, or null for normal vault files.
 */
export function externalPathOf(app: App, file: TAbstractFile | null | undefined): string | null {
	if (!file || !(file instanceof TFile)) return null;
	const anyFile = file as TFile & { getRealPath?: () => string };
	const Ext = (obsidian as unknown as { TExternalFile?: new (...a: unknown[]) => TFile }).TExternalFile;

	let looksExternal = false;
	if (Ext && file instanceof Ext) looksExternal = true;
	else if (/^file:/i.test(file.path)) looksExternal = true;
	if (!looksExternal) return null;

	let real = "";
	try {
		if (typeof anyFile.getRealPath === "function") real = String(anyFile.getRealPath() || "");
	} catch {
		/* fall through */
	}
	if (!real) {
		real = file.path.replace(/^file:(\/\/)?/i, "");
		if (/%[0-9a-f]{2}/i.test(real)) {
			try {
				real = decodeURIComponent(real);
			} catch {
				/* leave as-is */
			}
		}
	}
	if (!real) return null;
	if (!path.isAbsolute(real)) real = path.sep + real;

	// Belt and braces: never treat something already inside this vault as outside.
	const base = vaultBasePath(app);
	if (base && isInside(real, base)) return null;
	return real;
}

function vaultBasePath(app: App): string | null {
	const adapter = app.vault.adapter;
	return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default class OutsideNoteImporter extends Plugin {
	settings: IntakeSettings = { ...DEFAULT_SETTINGS };
	private statusEl: HTMLElement | null = null;
	/** Real paths the user said "Not now" to during this session. */
	private dismissed = new Set<string>();
	/** Real paths with a prompt or import currently in flight. */
	private busy = new Set<string>();

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new IntakeSettingTab(this.app, this));

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("oni-status");
		this.statusEl.setAttr("aria-label", "This note is outside your vault. Click to import it.");
		this.statusEl.setAttr("data-tooltip-position", "top");
		const icon = this.statusEl.createSpan({ cls: "oni-status-icon" });
		setIcon(icon, "download");
		this.statusEl.createSpan({ text: "Outside vault · Import" });
		this.statusEl.hide();
		this.registerDomEvent(this.statusEl, "click", () => {
			const file = this.app.workspace.getActiveFile();
			if (file instanceof TFile && externalPathOf(this.app, file)) this.prompt(file, true);
		});

		this.registerEvent(this.app.workspace.on("file-open", (file) => this.onFileOpen(file)));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshStatus()));

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || !externalPathOf(this.app, file)) return;
				menu.addItem((item) =>
					item
						.setTitle("Import into vault…")
						.setIcon("download")
						.setSection("action")
						.onClick(() => this.prompt(file, true)),
				);
			}),
		);

		this.addCommand({
			id: "import-active-outside-note",
			name: "Import this note into the vault",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || !externalPathOf(this.app, file)) return false;
				if (!checking) this.prompt(file, true);
				return true;
			},
		});

		// Catch an outside note that was already open when Obsidian launched.
		this.app.workspace.onLayoutReady(() => this.onFileOpen(this.app.workspace.getActiveFile()));
	}

	onunload() {
		this.statusEl = null;
	}

	async loadSettings() {
		const saved = ((await this.loadData()) ?? {}) as Partial<Omit<IntakeSettings, "ignoredFolders">> & {
			ignoredFolders?: string | string[];
		};
		const ignored = saved.ignoredFolders;
		this.settings = {
			...DEFAULT_SETTINGS,
			...saved,
			// v1.0.0 stored this as an array; it's now one folder per line.
			ignoredFolders: Array.isArray(ignored) ? ignored.join("\n") : (ignored ?? ""),
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ── Open handling ──────────────────────────────────────────────────────

	private refreshStatus() {
		if (!this.statusEl) return;
		const active = this.app.workspace.getActiveFile();
		if (externalPathOf(this.app, active)) this.statusEl.show();
		else this.statusEl.hide();
	}

	onFileOpen(file: TFile | null) {
		this.refreshStatus();
		const real = externalPathOf(this.app, file);
		if (!real || !file) return;
		if (!NOTE_EXTENSIONS.has(file.extension.toLowerCase())) return;
		if (this.settings.mode === "off") return;
		if (this.dismissed.has(real) || this.busy.has(real)) return;
		if (this.isIgnored(real)) return;
		if (this.settings.skipOtherVaults && owningVault(real, this.app.vault.configDir)) return;

		if (this.settings.mode === "auto") {
			void this.importFile(file, this.defaultFolder(), file.basename);
		} else {
			this.prompt(file, false);
		}
	}

	isIgnored(real: string): boolean {
		return folderLines(this.settings.ignoredFolders).some((f) => isInside(real, expandHome(f)));
	}

	/** Folder pre-filled in the prompt. */
	defaultFolder(): string {
		const exists = (p: string) => p === "" || this.app.vault.getFolderByPath(p) instanceof TFolder;
		if (this.settings.rememberLastFolder && this.settings.lastFolder && exists(this.settings.lastFolder)) {
			return this.settings.lastFolder;
		}
		const configured = cleanFolder(this.settings.defaultFolder);
		if (configured) return configured;
		try {
			return cleanFolder(this.app.fileManager.getNewFileParent("").path);
		} catch {
			return "";
		}
	}

	prompt(file: TFile, explicit: boolean) {
		const real = externalPathOf(this.app, file);
		if (!real || this.busy.has(real)) return;
		this.busy.add(real);
		new ImportModal(this.app, this, file, real, explicit, () => this.busy.delete(real)).open();
	}

	dismiss(real: string) {
		this.dismissed.add(real);
	}

	async ignoreFolderOf(real: string) {
		const dir = tildify(path.dirname(real));
		const lines = folderLines(this.settings.ignoredFolders);
		if (!lines.includes(dir)) {
			this.settings.ignoredFolders = [...lines, dir].join("\n");
			await this.saveSettings();
		}
		new Notice(`Won't ask about notes in ${dir} again. You can undo this in settings.`);
	}

	// ── Import ─────────────────────────────────────────────────────────────

	async importFile(file: TFile, folderInput: string, nameInput: string): Promise<TFile | null> {
		const real = externalPathOf(this.app, file);
		if (!real) return null;
		this.busy.add(real);
		try {
			const base = sanitizeName(nameInput) || sanitizeName(file.basename) || "Untitled";
			const ext = file.extension || "md";

			const folder = await this.ensureFolder(cleanFolder(folderInput));
			const target = await this.availablePath(folder, base, ext);

			// Prefer what's in the editor (catches edits made in Obsidian that
			// haven't hit disk yet); otherwise copy the bytes from disk exactly.
			const editorText = this.editorTextFor(real);
			let created: TFile;
			if (editorText !== null) {
				created = await this.app.vault.create(target, editorText);
			} else {
				const buf = await fs.promises.readFile(real);
				const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
				created = await this.app.vault.createBinary(target, ab);
			}

			await this.swapLeaves(real, created);

			if (this.settings.rememberLastFolder) {
				this.settings.lastFolder = folder;
				await this.saveSettings();
			}

			let originalNote = "";
			if (this.settings.original === "trash") {
				const trashed = await this.trashOriginal(real);
				originalNote = trashed
					? " The original went to the Trash."
					: ` Couldn't move the original to the Trash; it's still at ${tildify(real)}.`;
			}

			const where = folder ? folder : "the vault root";
			new Notice(`Imported “${created.name}” to ${where}.${originalNote}`, 6000);
			this.refreshStatus();
			return created;
		} catch (err) {
			console.error("[outside-note-importer] import failed", err);
			new Notice(`Couldn't import ${path.basename(real)}: ${(err as Error)?.message ?? err}`, 8000);
			return null;
		} finally {
			this.busy.delete(real);
		}
	}

	/**
	 * Make sure the folder exists and return its real path. Matches existing
	 * folders case-insensitively ("inbox" → "Inbox"), since macOS won't let
	 * two folders differ only by case.
	 */
	private async ensureFolder(folder: string): Promise<string> {
		if (!folder) return "";
		const existing = new Map<string, string>();
		for (const f of this.app.vault.getAllFolders(false)) existing.set(f.path.toLowerCase(), f.path);

		let acc = "";
		for (const part of folder.split("/").filter(Boolean)) {
			const want = acc ? `${acc}/${part}` : part;
			const match = existing.get(want.toLowerCase());
			if (match) {
				acc = match;
				continue;
			}
			acc = want;
			try {
				await this.app.vault.createFolder(acc);
			} catch (err) {
				// Already on disk but not indexed yet: fine. Anything else: real error.
				if (!(await this.app.vault.adapter.exists(acc))) throw err;
			}
		}
		return acc;
	}

	/** "Note.md", then "Note 1.md", "Note 2.md"… (Obsidian's own convention). */
	async availablePath(folder: string, base: string, ext: string): Promise<string> {
		const make = (suffix: string) => normalizePath(`${folder ? folder + "/" : ""}${base}${suffix}.${ext}`);
		let candidate = make("");
		let n = 1;
		// adapter.exists is case-insensitive on macOS, which is what we want.
		while (this.app.vault.getAbstractFileByPath(candidate) || (await this.app.vault.adapter.exists(candidate))) {
			candidate = make(` ${n++}`);
		}
		return candidate;
	}

	private leavesShowing(real: string): WorkspaceLeaf[] {
		const hits: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			const viewFile = (leaf.view as { file?: TFile | null }).file ?? null;
			if (viewFile && externalPathOf(this.app, viewFile) === real) {
				hits.push(leaf);
				return;
			}
			// Deferred (not yet loaded) tabs only carry their state.
			const stateFile = leaf.getViewState()?.state?.file;
			if (typeof stateFile === "string" && /^file:/i.test(stateFile)) {
				const p = stateFile.replace(/^file:(\/\/)?/i, "");
				if (canonical(p) === canonical(real)) hits.push(leaf);
			}
		});
		return hits;
	}

	private editorTextFor(real: string): string | null {
		for (const leaf of this.leavesShowing(real)) {
			if (leaf.view instanceof MarkdownView) {
				try {
					return leaf.view.getViewData();
				} catch {
					/* try next */
				}
			}
		}
		return null;
	}

	private async swapLeaves(real: string, created: TFile) {
		for (const leaf of this.leavesShowing(real)) {
			await leaf.openFile(created);
		}
	}

	private async trashOriginal(real: string): Promise<boolean> {
		try {
			// Electron's shell is the only way to reach the macOS Trash (recoverable,
			// unlike fs.unlink). Desktop-only; the manifest sets isDesktopOnly.
			const electron = require("electron") as { shell: { trashItem(p: string): Promise<void> } };
			await electron.shell.trashItem(real);
			return true;
		} catch (err) {
			console.warn("[outside-note-importer] couldn't trash original", err);
			return false;
		}
	}
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

class ImportModal extends Modal {
	private folder: string;
	private name: string;
	private resolved = false;

	constructor(
		app: App,
		private plugin: OutsideNoteImporter,
		private file: TFile,
		private real: string,
		private explicit: boolean,
		private onDone: () => void,
	) {
		super(app);
		this.folder = plugin.defaultFolder();
		this.name = file.basename;
	}

	onOpen() {
		const { contentEl } = this;
		this.modalEl.addClass("oni-modal");
		this.setTitle("Import into your vault?");

		contentEl.createEl("p", {
			cls: "oni-lede",
			text: "This note is outside your vault, so it won't show up in search, links, or the file list.",
		});
		contentEl.createDiv({ cls: "oni-source", text: tildify(this.real) });

		new Setting(contentEl).setName("Name").addText((t) => {
			t.setValue(this.name).onChange((v) => (this.name = v));
			t.inputEl.addClass("oni-input");
		});

		new Setting(contentEl)
			.setName("Folder")
			.setDesc("Start typing to pick a vault folder. A new name creates the folder.")
			.addText((t) => {
				t.setPlaceholder("/ (vault root)")
					.setValue(this.folder)
					.onChange((v) => (this.folder = v));
				t.inputEl.addClass("oni-input");
				new FolderSuggest(this.app, t.inputEl);
				window.setTimeout(() => t.inputEl.focus(), 0);
			});

		const footer = contentEl.createDiv({ cls: "oni-footer" });
		const never = footer.createEl("button", {
			cls: "oni-link",
			text: `Never ask for ${tildify(path.dirname(this.real))}`,
		});
		never.addEventListener("click", () => {
			this.resolved = true;
			this.close();
			void this.plugin.ignoreFolderOf(this.real);
		});

		const buttons = footer.createDiv({ cls: "oni-buttons" });
		buttons.createEl("button", { text: "Not now" }).addEventListener("click", () => this.close());
		const go = buttons.createEl("button", { cls: "mod-cta", text: "Import" });
		go.addEventListener("click", () => void this.submit());

		this.scope.register([], "Enter", (evt) => {
			// Let the folder suggester consume Enter while it's open.
			if (activeDocument.querySelector(".suggestion-container")) return;
			evt.preventDefault();
			void this.submit();
		});
	}

	private async submit() {
		if (this.resolved) return;
		this.resolved = true;
		this.close();
		this.onDone(); // release before importFile re-claims it
		await this.plugin.importFile(this.file, this.folder, this.name);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.resolved && !this.explicit) this.plugin.dismiss(this.real);
		this.onDone();
	}
}

class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(app: App, private input: HTMLInputElement) {
		super(app, input);
	}

	getSuggestions(query: string): TFolder[] {
		const q = query.toLowerCase().trim();
		return this.app.vault
			.getAllFolders(true)
			.filter((f) => (f.isRoot() ? "/" : f.path).toLowerCase().includes(q))
			.sort((a, b) => a.path.localeCompare(b.path))
			.slice(0, 50);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement) {
		el.setText(folder.isRoot() ? "/ (vault root)" : folder.path);
	}

	selectSuggestion(folder: TFolder) {
		this.setValue(folder.isRoot() ? "" : folder.path);
		this.input.dispatchEvent(new Event("input"));
		this.close();
	}
}

// ─── Settings tab ────────────────────────────────────────────────────────────
// Declarative settings (Obsidian 1.13+): Obsidian renders these, indexes them
// for settings search, and reads/writes plugin.settings through the two
// overrides below.

class IntakeSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: OutsideNoteImporter) {
		super(app, plugin);
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof IntakeSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings as unknown as Record<string, unknown>;
		s[key] = key === "defaultFolder" && typeof value === "string" ? cleanFolder(value) : value;
		await this.plugin.saveSettings();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const configDir = this.app.vault.configDir;
		return [
			{
				name: "When a note from outside the vault opens",
				desc: "Applies to Markdown files opened from Finder, Open With, or “Open file from outside the vault…”.",
				aliases: ["import", "outside", "downloads"],
				control: {
					type: "dropdown",
					key: "mode",
					defaultValue: DEFAULT_SETTINGS.mode,
					options: { ask: "Ask me", auto: "Import automatically", off: "Do nothing" },
				},
			},
			{
				name: "Default folder",
				desc: "Where imports go unless you pick another folder. Leave empty to use Obsidian's “Default location for new notes”.",
				control: { type: "folder", key: "defaultFolder", includeRoot: true, placeholder: "e.g. Inbox" },
			},
			{
				name: "Remember the last folder I picked",
				desc: "Pre-fill the prompt with the folder you used last time instead of the default folder.",
				control: { type: "toggle", key: "rememberLastFolder" },
			},
			{
				name: "After importing",
				desc: "Moving to the Trash keeps Downloads clean and is recoverable.",
				control: {
					type: "dropdown",
					key: "original",
					defaultValue: DEFAULT_SETTINGS.original,
					options: { trash: "Move the original to the Trash", keep: "Leave the original where it is" },
				},
			},
			{
				name: "Skip notes that belong to another vault",
				desc: `Don't prompt for files inside a folder that has its own ${configDir} folder.`,
				control: { type: "toggle", key: "skipOtherVaults" },
			},
			{
				name: "Never ask about these folders",
				desc: "One folder per line. ~ means your home folder. The command and the status bar button still work for these.",
				control: { type: "textarea", key: "ignoredFolders", rows: 4, placeholder: "~/Projects/docs" },
			},
		];
	}
}
