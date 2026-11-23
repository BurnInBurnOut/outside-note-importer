import esbuild from "esbuild";
import { builtinModules } from "node:module";
await esbuild.build({
	entryPoints: ["src/main.ts"],
	bundle: true,
	format: "cjs",
	target: "es2020",
	platform: "node",
	outfile: "main.js",
	external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules],
	banner: { js: "/* Outside Note Importer — built for Obsidian 1.14.4+ */" },
	logLevel: "info",
});
