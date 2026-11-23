// End-to-end test of the bundled main.js against a mocked Obsidian runtime.
// Real filesystem: a temp vault, a fake Downloads folder, another vault, a trash dir.
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const assert = require("assert");
const { JSDOM } = require("jsdom");

// ── DOM with Obsidian's HTMLElement helpers ─────────────────────────────────
const dom = new JSDOM("<!doctype html><body></body>");
global.window = dom.window;
global.document = dom.window.document;
global.Event = dom.window.Event;
global.activeDocument = dom.window.document;
const HP = dom.window.HTMLElement.prototype;
function mk(tag, o = {}, parent) {
	const el = document.createElement(tag);
	if (typeof o === "string") o = { cls: o };
	if (o.cls) el.className = o.cls;
	if (o.text) el.textContent = o.text;
	if (parent) parent.appendChild(el);
	return el;
}
HP.createEl = function (t, o) { return mk(t, o, this); };
HP.createDiv = function (o) { return mk("div", o, this); };
HP.createSpan = function (o) { return mk("span", o, this); };
HP.addClass = function (c) { this.classList.add(c); };
HP.setAttr = function (k, v) { this.setAttribute(k, v); };
HP.setText = function (t) { this.textContent = t; };
HP.empty = function () { this.innerHTML = ""; };
HP.hide = function () { this.style.display = "none"; };
HP.show = function () { this.style.display = ""; };
HP.isShown = function () { return this.style.display !== "none"; };

// ── Temp filesystem ─────────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), "oni-"));
const VAULT = path.join(root, "MyVault");
const DOWNLOADS = path.join(root, "Downloads");
const OTHER = path.join(root, "OtherVault");
const TRASH = path.join(root, ".Trash");
for (const d of [VAULT, path.join(VAULT, ".obsidian"), path.join(VAULT, "Notes"), DOWNLOADS, path.join(OTHER, ".obsidian"), TRASH])
	fs.mkdirSync(d, { recursive: true });

// ── electron mock ───────────────────────────────────────────────────────────
let trashShouldFail = false;
const electronMock = {
	shell: {
		async trashItem(p) {
			if (trashShouldFail) throw new Error("trash denied");
			fs.renameSync(p, path.join(TRASH, path.basename(p) + "." + Date.now()));
		},
	},
};

// ── obsidian mock ───────────────────────────────────────────────────────────
class TAbstractFile { constructor(p) { this.path = p; this.name = path.posix.basename(p); } }
class TFile extends TAbstractFile {
	constructor(p) {
		super(p);
		const ext = path.posix.extname(p);
		this.extension = ext.slice(1);
		this.basename = path.posix.basename(p, ext);
	}
}
class TExternalFile extends TFile {
	constructor(abs) { super("file:" + abs); this._abs = abs; }
	getRealPath() { return this._abs; }
}
class TFolder extends TAbstractFile { isRoot() { return this.path === "/"; } }
class FileSystemAdapter {
	constructor(base) { this.base = base; }
	getBasePath() { return this.base; }
	async exists(p) {
		// emulate macOS case-insensitivity
		const dir = path.join(this.base, path.dirname(p));
		if (!fs.existsSync(dir)) return false;
		return fs.readdirSync(dir).some((n) => n.toLowerCase() === path.basename(p).toLowerCase());
	}
}
class View { constructor(leaf) { this.leaf = leaf; } }
class MarkdownView extends View {
	constructor(leaf, file, text) { super(leaf); this.file = file; this._text = text; }
	getViewData() { return this._text; }
}
const notices = [];
class Notice { constructor(msg) { notices.push(msg); } }
const openModals = [];
class Scope { constructor() { this.keys = []; } register(m, k, fn) { this.keys.push({ k, fn }); } }
class Modal {
	constructor(app) {
		this.app = app;
		this.modalEl = document.createElement("div");
		this.titleEl = mk("div", {}, this.modalEl);
		this.contentEl = mk("div", {}, this.modalEl);
		this.scope = new Scope();
	}
	setTitle(t) { this.titleEl.textContent = t; return this; }
	open() { openModals.push(this); document.body.appendChild(this.modalEl); this.onOpen(); }
	close() { const i = openModals.indexOf(this); if (i >= 0) openModals.splice(i, 1); this.modalEl.remove(); this.onClose(); }
}
class TextComponent {
	constructor(parent) { this.inputEl = mk("input", {}, parent); this._cb = null; this.inputEl.addEventListener("input", () => this._cb && this._cb(this.inputEl.value)); }
	setValue(v) { this.inputEl.value = v; return this; }
	setPlaceholder(p) { this.inputEl.placeholder = p; return this; }
	onChange(cb) { this._cb = cb; return this; }
}
class Setting {
	constructor(el) { this.settingEl = mk("div", "setting-item", el); }
	setName(n) { mk("div", { cls: "setting-item-name", text: n }, this.settingEl); return this; }
	setDesc() { return this; }
	addText(cb) { cb(new TextComponent(this.settingEl)); return this; }
	addTextArea(cb) { const t = new TextComponent(this.settingEl); cb(t); return this; }
	addToggle(cb) { const t = { setValue() { return t; }, onChange() { return t; } }; cb(t); return this; }
	addDropdown(cb) { const d = { addOptions() { return d; }, setValue() { return d; }, onChange() { return d; } }; cb(d); return this; }
}
class AbstractInputSuggest { constructor(app, el) { this.app = app; this.el = el; } setValue(v) { this.el.value = v; } close() {} }
class Plugin {
	constructor(app, manifest) { this.app = app; this.manifest = manifest; this._data = null; this._events = []; }
	async loadData() { return this._data; }
	async saveData(d) { this._data = JSON.parse(JSON.stringify(d)); }
	addSettingTab(t) { this.settingTab = t; }
	addStatusBarItem() { return mk("div", {}, document.body); }
	registerDomEvent(el, ev, fn) { el.addEventListener(ev, fn); }
	registerEvent() {}
	addCommand(c) { this.commands = this.commands || {}; this.commands[c.id] = c; }
}
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = document.createElement("div"); } }
function normalizePath(p) { p = p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, ""); return p === "" ? "/" : p; }
const obsidianMock = {
	TAbstractFile, TFile, TFolder, TExternalFile, FileSystemAdapter, MarkdownView, Modal, Notice, Plugin,
	PluginSettingTab, Setting, AbstractInputSuggest, normalizePath, setIcon() {},
};

// ── Mock App ────────────────────────────────────────────────────────────────
function makeApp() {
	const files = new Map(); // vault path -> TFile/TFolder
	const rootFolder = new TFolder("/");
	const addFolder = (p) => { const f = new TFolder(p); files.set(p, f); return f; };
	addFolder("Notes");
	const handlers = {};
	const leaves = [];
	let active = null;
	const app = {
		vault: {
			adapter: new FileSystemAdapter(VAULT),
			configDir: ".obsidian",
			getAbstractFileByPath: (p) => files.get(p) || null,
			getFolderByPath: (p) => (p === "" || p === "/" ? rootFolder : files.get(p) instanceof TFolder ? files.get(p) : null),
			getAllFolders: (inc) => [...(inc ? [rootFolder] : []), ...[...files.values()].filter((f) => f instanceof TFolder)],
			async createFolder(p) { fs.mkdirSync(path.join(VAULT, p)); return addFolder(p); },
			async create(p, text) {
				if (files.has(p)) throw new Error("File already exists.");
				fs.writeFileSync(path.join(VAULT, p), text, "utf8");
				const f = new TFile(p); files.set(p, f); return f;
			},
			async createBinary(p, ab) {
				if (files.has(p)) throw new Error("File already exists.");
				fs.writeFileSync(path.join(VAULT, p), Buffer.from(ab));
				const f = new TFile(p); files.set(p, f); return f;
			},
		},
		fileManager: { getNewFileParent: () => files.get("Notes") },
		workspace: {
			on(name, cb) { (handlers[name] = handlers[name] || []).push(cb); return {}; },
			trigger(name, ...a) { (handlers[name] || []).forEach((cb) => cb(...a)); },
			getActiveFile: () => active,
			iterateAllLeaves: (cb) => leaves.forEach(cb),
			onLayoutReady: (cb) => cb(),
		},
		// test helpers
		_files: files, _leaves: leaves,
		_openExternal(abs, { deferred = false } = {}) {
			const file = new TExternalFile(abs);
			const leaf = {
				view: null,
				getViewState: () => ({ type: "markdown", state: { file: file.path } }),
				async openFile(f) { this.view = new MarkdownView(this, f, ""); this.getViewState = () => ({ type: "markdown", state: { file: f.path } }); active = f; app.workspace.trigger("file-open", f); },
			};
			leaf.view = deferred ? { leaf } : new MarkdownView(leaf, file, fs.readFileSync(abs, "utf8") + (this._editSuffix || ""));
			leaves.push(leaf);
			active = file;
			app.workspace.trigger("file-open", file);
			return { file, leaf };
		},
		_setActive(f) { active = f; app.workspace.trigger("active-leaf-change"); },
	};
	return app;
}

// ── Load bundle with mocks ──────────────────────────────────────────────────
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
	if (req === "obsidian" || req === "electron") return req;
	return origResolve.call(this, req, ...rest);
};
require.cache.obsidian = { id: "obsidian", filename: "obsidian", loaded: true, exports: obsidianMock };
require.cache.electron = { id: "electron", filename: "electron", loaded: true, exports: electronMock };
const bundle = require(path.join(__dirname, "..", "main.js"));
const PluginClass = bundle.default;

const tick = () => new Promise((r) => setTimeout(r, 5));
async function boot(settings) {
	const app = makeApp();
	const plugin = new PluginClass(app, {});
	if (settings) plugin._data = settings;
	await plugin.onload();
	return { app, plugin };
}
function dl(name, body = "# hello\n") { const p = path.join(DOWNLOADS, name); fs.writeFileSync(p, body); return p; }
function modalFor(m) {
	const inputs = m.contentEl.querySelectorAll("input");
	const buttons = [...m.contentEl.querySelectorAll("button")];
	return {
		name: inputs[0], folder: inputs[1],
		set(el, v) { el.value = v; el.dispatchEvent(new Event("input")); },
		click(label) { buttons.find((b) => b.textContent.startsWith(label)).click(); },
		text: m.contentEl.textContent, title: m.titleEl.textContent,
	};
}

const results = [];
async function test(name, fn) {
	openModals.length = 0; notices.length = 0; trashShouldFail = false;
	try { await fn(); results.push(["PASS", name]); }
	catch (e) { results.push(["FAIL", name, e.stack.split("\n").slice(0, 3).join(" | ")]); }
}

(async () => {
	await test("prompts when an outside note opens, shows path + default folder", async () => {
		const { app } = await boot();
		const p = dl("plan.md");
		app._openExternal(p);
		assert.strictEqual(openModals.length, 1);
		const m = modalFor(openModals[0]);
		assert.strictEqual(m.title, "Import into your vault?");
		assert.ok(m.text.includes("Downloads/plan.md"));
		assert.strictEqual(m.name.value, "plan");
		assert.strictEqual(m.folder.value, "Notes", "falls back to Obsidian's new-note location");
	});

	await test("Import: creates note in chosen (new, nested) folder, swaps tab, trashes original, remembers folder", async () => {
		const { app, plugin } = await boot();
		const p = dl("brief.md", "# Brief\nbody\n");
		app._editSuffix = "edited in obsidian\n";
		const { leaf } = app._openExternal(p);
		app._editSuffix = "";
		const m = modalFor(openModals[0]);
		m.set(m.folder, "Inbox/AI");
		m.click("Import");
		await tick();
		const dest = path.join(VAULT, "Inbox/AI/brief.md");
		assert.ok(fs.existsSync(dest), "file created");
		assert.strictEqual(fs.readFileSync(dest, "utf8"), "# Brief\nbody\nedited in obsidian\n", "editor content kept");
		assert.strictEqual(leaf.view.file.path, "Inbox/AI/brief.md", "tab now shows vault copy");
		assert.ok(!fs.existsSync(p), "original moved to trash");
		assert.strictEqual(plugin.settings.lastFolder, "Inbox/AI");
		assert.ok(notices.some((n) => n.includes("Imported “brief.md” to Inbox/AI") && n.includes("Trash")), notices.join(" / "));
		assert.strictEqual(openModals.length, 0, "no re-prompt for the imported vault file");
	});

	await test("remembered folder pre-fills next prompt", async () => {
		const { app } = await boot({ lastFolder: "Notes" });
		app._files.set("Inbox", new TFolder("Inbox"));
		const { plugin } = { plugin: null };
		app._openExternal(dl("x.md"));
		assert.strictEqual(modalFor(openModals[0]).folder.value, "Notes");
	});

	await test("name collision → 'name 1.md' (case-insensitive)", async () => {
		const { app } = await boot();
		fs.writeFileSync(path.join(VAULT, "Notes", "Dup.md"), "existing");
		app._files.set("Notes/Dup.md", new TFile("Notes/Dup.md"));
		fs.writeFileSync(path.join(VAULT, "Notes", "dup 1.md"), "existing2"); // only on disk, different case
		const p = dl("dup.md", "new");
		app._openExternal(p);
		const m = modalFor(openModals[0]);
		m.set(m.name, "Dup");
		m.click("Import");
		await tick();
		assert.ok(fs.existsSync(path.join(VAULT, "Notes", "Dup 2.md")), fs.readdirSync(path.join(VAULT, "Notes")).join(","));
		assert.strictEqual(fs.readFileSync(path.join(VAULT, "Notes", "Dup.md"), "utf8"), "existing", "didn't overwrite");
	});

	await test("rename with illegal characters is sanitized", async () => {
		const { app } = await boot();
		app._openExternal(dl("r.md"));
		const m = modalFor(openModals[0]);
		m.set(m.name, "Q3: plan/draft?");
		m.click("Import");
		await tick();
		assert.ok(fs.existsSync(path.join(VAULT, "Notes", "Q3- plan-draft-.md")));
	});

	await test("Not now: no re-prompt this session; status bar stays; command still works", async () => {
		const { app, plugin } = await boot();
		const p = dl("later.md");
		const { file } = app._openExternal(p);
		modalFor(openModals[0]).click("Not now");
		assert.strictEqual(openModals.length, 0);
		app.workspace.trigger("file-open", file);
		assert.strictEqual(openModals.length, 0, "no nag on revisit");
		const status = document.querySelector(".oni-status:last-of-type");
		assert.ok(plugin.statusEl.isShown(), "status bar visible for outside note");
		assert.strictEqual(plugin.commands["import-active-outside-note"].checkCallback(true), true);
		plugin.commands["import-active-outside-note"].checkCallback(false);
		assert.strictEqual(openModals.length, 1, "command re-opens prompt");
		modalFor(openModals[0]).click("Not now");
		plugin.statusEl.click();
		assert.strictEqual(openModals.length, 1, "status bar click opens prompt");
		assert.ok(fs.existsSync(p), "original untouched");
	});

	await test("status bar hidden for vault notes; command unavailable", async () => {
		const { app, plugin } = await boot();
		app._setActive(new TFile("Notes/a.md"));
		assert.ok(!plugin.statusEl.isShown());
		assert.strictEqual(plugin.commands["import-active-outside-note"].checkCallback(true), false);
	});

	await test("file-menu item only for outside notes", async () => {
		const { app } = await boot();
		const items = [];
		const menu = { addItem(cb) { const it = { setTitle(t) { it.t = t; return it; }, setIcon() { return it; }, setSection() { return it; }, onClick() { return it; } }; cb(it); items.push(it.t); } };
		app.workspace.trigger("file-menu", menu, new TFile("Notes/a.md"));
		assert.strictEqual(items.length, 0);
		app.workspace.trigger("file-menu", menu, new TExternalFile(dl("m.md")));
		assert.deepStrictEqual(items, ["Import into vault…"]);
	});

	await test("files inside another vault are skipped", async () => {
		const { app } = await boot();
		const p = path.join(OTHER, "theirs.md"); fs.writeFileSync(p, "x");
		app._openExternal(p);
		assert.strictEqual(openModals.length, 0);
	});

	await test("'Never ask for this folder' persists and suppresses", async () => {
		const { app, plugin } = await boot();
		app._openExternal(dl("n1.md"));
		modalFor(openModals[0]).click("Never ask");
		await tick();
		assert.strictEqual(plugin.settings.ignoredFolders.split("\n").length, 1);
		app._openExternal(dl("n2.md"));
		assert.strictEqual(openModals.length, 0);
	});

	await test("mode=auto imports without asking", async () => {
		const { app } = await boot({ mode: "auto", defaultFolder: "Inbox" });
		const p = dl("auto.md", "auto");
		app._openExternal(p);
		await tick();
		assert.strictEqual(openModals.length, 0);
		assert.strictEqual(fs.readFileSync(path.join(VAULT, "Inbox", "auto.md"), "utf8"), "auto");
		assert.ok(!fs.existsSync(p));
	});

	await test("mode=off does nothing (but status bar still shows)", async () => {
		const { app, plugin } = await boot({ mode: "off" });
		app._openExternal(dl("off.md"));
		assert.strictEqual(openModals.length, 0);
		assert.ok(plugin.statusEl.isShown());
	});

	await test("original=keep leaves the original", async () => {
		const { app } = await boot({ original: "keep" });
		const p = dl("keep.md");
		app._openExternal(p);
		modalFor(openModals[0]).click("Import");
		await tick();
		assert.ok(fs.existsSync(p));
		assert.ok(!notices.join().includes("Trash"));
	});

	await test("deferred tab (no editor): exact bytes copied from disk; tab still swapped", async () => {
		const { app } = await boot();
		const bytes = "café \r\n\u{1F600} done";
		const p = dl("bytes.md", bytes);
		const { leaf } = app._openExternal(p, { deferred: true });
		modalFor(openModals[0]).click("Import");
		await tick();
		assert.strictEqual(fs.readFileSync(path.join(VAULT, "Notes", "bytes.md"), "utf8"), bytes);
		assert.strictEqual(leaf.view.file.path, "Notes/bytes.md");
	});

	await test("trash failure: import still succeeds, user told where original is", async () => {
		const { app } = await boot();
		trashShouldFail = true;
		const p = dl("stuck.md");
		app._openExternal(p);
		modalFor(openModals[0]).click("Import");
		await tick();
		assert.ok(fs.existsSync(path.join(VAULT, "Notes", "stuck.md")));
		assert.ok(fs.existsSync(p));
		assert.ok(notices.some((n) => n.includes("Couldn't move the original")), notices.join(" / "));
	});

	await test("non-markdown outside files don't auto-prompt", async () => {
		const { app } = await boot();
		const p = path.join(DOWNLOADS, "doc.pdf"); fs.writeFileSync(p, "%PDF");
		app._openExternal(p);
		assert.strictEqual(openModals.length, 0);
	});

	await test("typing 'notes' reuses existing 'Notes' folder (macOS case rules)", async () => {
		const { app } = await boot({ original: "keep" });
		app._openExternal(dl("case.md"));
		const m = modalFor(openModals[0]);
		m.set(m.folder, "notes");
		m.click("Import");
		await tick();
		assert.ok(fs.existsSync(path.join(VAULT, "Notes", "case.md")));
		assert.ok(notices.some((n) => n.includes("to Notes.")), notices.join(" / "));
	});

	await test("folder on disk but not yet indexed doesn't break import", async () => {
		const { app } = await boot({ original: "keep" });
		fs.mkdirSync(path.join(VAULT, "Unindexed"), { recursive: true });
		app._openExternal(dl("ui.md"));
		const m = modalFor(openModals[0]);
		m.set(m.folder, "Unindexed");
		m.click("Import");
		await tick();
		assert.ok(fs.existsSync(path.join(VAULT, "Unindexed", "ui.md")), notices.join(" / "));
	});

	await test("v1.0.0 array settings migrate to one-per-line text", async () => {
		const { app, plugin } = await boot({ ignoredFolders: [DOWNLOADS, "~/Elsewhere"] });
		assert.strictEqual(plugin.settings.ignoredFolders, DOWNLOADS + "\n~/Elsewhere");
		app._openExternal(dl("mig.md"));
		assert.strictEqual(openModals.length, 0, "migrated ignore list still applies");
	});

	await test("declarative settings: definitions bind to real keys and save", async () => {
		const { plugin } = await boot();
		const tab = plugin.settingTab;
		const defs = tab.getSettingDefinitions();
		const keys = defs.map((d) => d.control.key);
		for (const k of keys) assert.ok(k in plugin.settings, "unknown key " + k);
		assert.strictEqual(defs.length, 6);
		await tab.setControlValue("defaultFolder", "/Inbox/");
		assert.strictEqual(plugin.settings.defaultFolder, "Inbox");
		assert.strictEqual(plugin._data.defaultFolder, "Inbox", "persisted");
		await tab.setControlValue("mode", "auto");
		assert.strictEqual(tab.getControlValue("mode"), "auto");
	});

	await test("double-submit (Enter + click) imports once", async () => {
		const { app } = await boot({ original: "keep" });
		app._openExternal(dl("once.md"));
		const modal = openModals[0];
		const enter = modal.scope.keys.find((k) => k.k === "Enter");
		enter.fn({ preventDefault() {} });
		await tick();
		assert.ok(fs.existsSync(path.join(VAULT, "Notes", "once.md")));
		assert.ok(!fs.existsSync(path.join(VAULT, "Notes", "once 1.md")));
	});

	for (const r of results) console.log(r.join("  "));
	const failed = results.filter((r) => r[0] === "FAIL").length;
	console.log(`\n${results.length - failed}/${results.length} passed`);
	fs.rmSync(root, { recursive: true, force: true });
	process.exit(failed ? 1 : 0);
})();
