import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

// Obsidian's own review rules, plus typescript-eslint's type-checked sets,
// which the community directory scanner also applies to source files.
const tsOnly = (configs) => configs.map((c) => ({ ...c, files: ["**/*.ts"] }));

export default defineConfig([
	globalIgnores(["node_modules", "dist", "main.js", "esbuild.config.mjs", "test", "release"]),
	...obsidianmd.configs.recommended,
	...tsOnly(tseslint.configs.recommendedTypeChecked),
	...tsOnly(tseslint.configs.stylisticTypeChecked),
	{
		languageOptions: {
			parserOptions: {
				projectService: { allowDefaultProject: ["eslint.config.*"] },
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
]);
