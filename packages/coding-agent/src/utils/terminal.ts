// True when running inside VS Code's integrated terminal. VS Code routes OSC 8
// hyperlinks to the host OS protocol handler, which breaks for file paths under
// Remote-WSL/SSH; callers use this to emit plain-text paths instead and let
// VS Code's own terminal link detector open them in the active workspace.
//
// Kept local to coding-agent (rather than imported from pi-tui) so the fork's
// "patches touch coding-agent only" deploy model holds: the global pi-tui is
// pinned to the registry build and would not have this export.
export function isVscodeTerminal(): boolean {
	return (process.env.TERM_PROGRAM || "").toLowerCase() === "vscode";
}
