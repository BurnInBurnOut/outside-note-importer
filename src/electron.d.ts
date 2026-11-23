// Minimal type for the one Electron API this plugin uses. Obsidian desktop
// provides the "electron" module at runtime; installing the full electron
// package just for types would add a ~100 MB download to every build.
declare module "electron" {
	export const shell: {
		/** Moves a file to the OS trash (macOS Trash, Windows Recycle Bin). */
		trashItem(path: string): Promise<void>;
	};
}
