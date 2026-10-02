import { type TUI, TuiAltScreen } from "@earendil-works/pi-tui";

/**
 * Plays the 3D Armin easter egg (see armin-3d.ts), which loads on first use. Only fullscreen mode can show it,
 * because it dissolves the rendered screen. The screen is captured before loading. Returns false when it cannot
 * play, so the caller can fall back to the inline version.
 */
export function playArmin3d(tui: TUI): boolean {
	if (!(tui instanceof TuiAltScreen)) return false;
	if (tui.hasOverlay()) return true;
	const screen = tui.getScreenLines();
	import("./armin-3d.ts").then(
		(module) => module.playArmin3d(tui, screen),
		() => {},
	);
	return true;
}
