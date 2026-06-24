/**
 * Config Center — one /config home for every extension's settings.
 *
 * Extensions register their knobs into a process-global registry; this owns the
 * single `/config` command and renders them all in one SettingsList UI.
 *
 *   /config                 Open the settings UI (TUI)
 *   /config <id>            Show one setting's current value
 *   /config <id> <value>    Set it directly (e.g. /config recaps off)
 *
 * HOW EXTENSIONS OPT IN — copy this 8-line helper into your extension and call
 * it from your factory (no shared import needed; the registry lives on
 * globalThis so it works no matter how extensions are bundled/loaded):
 *
 *   type ConfigSetting = { id: string; label: string; values: string[];
 *     get: () => string; set: (v: string) => void };
 *   function registerSetting(s: ConfigSetting) {
 *   function registerSetting(s: ConfigSetting) {
 *     const g = globalThis as any;
 *     g.__piConfigSettings ??= new Map();
 *     g.__piConfigSettings.set(s.id, s);
 *   }
 *   }
 *
 * ponytail: globalThis Map, not pi.events — emit-before-listen would drop
 * registrations on load-order races. Stale descriptors from removed extensions
 * linger until process exit; acceptable for a process-scoped prefs registry.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

interface ConfigSetting {
	id: string;
	label: string;
	values: string[];
	get: () => string;
	set: (value: string) => void;
}

function registry(): Map<string, ConfigSetting> {
	const g = globalThis as any;
	g.__piConfigSettings ??= new Map<string, ConfigSetting>();
	return g.__piConfigSettings;
}

function sortedSettings(): ConfigSetting[] {
	return [...registry().values()].sort((a, b) => a.label.localeCompare(b.label));
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("config", {
		description: "Configure extension settings (usage: /config [<id> [value]])",
		getArgumentCompletions: (prefix: string) => {
			const items = sortedSettings().map((s) => ({
				value: s.id,
				label: s.id,
				description: `${s.label} (${s.get()})`,
			}));
			const p = prefix.trim().toLowerCase();
			const f = p ? items.filter((i) => i.value.toLowerCase().startsWith(p)) : items;
			return f.length ? f : null;
		},
		handler: async (args, ctx) => {
			const settings = sortedSettings();
			const [id, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const value = rest.join(" ");

			// ── CLI path: /config <id> [value] ──────────────────────────────
			if (id) {
				const setting = registry().get(id);
				if (!setting) {
					const ids = settings.map((s) => s.id).join(", ") || "(none registered)";
					ctx.ui.notify(`Unknown setting "${id}". Available: ${ids}`, "warning");
					return;
				}
				if (!value) {
					ctx.ui.notify(
						`${setting.label} (${setting.id}) = ${setting.get()} — options: ${setting.values.join(", ")}`,
						"info",
					);
					return;
				}
				if (!setting.values.includes(value)) {
					ctx.ui.notify(
						`Invalid value "${value}" for ${setting.id}. Options: ${setting.values.join(", ")}`,
						"warning",
					);
					return;
				}
				setting.set(value);
				ctx.ui.notify(`${setting.label} = ${value}`, "info");
				return;
			}

			// ── No args: open the UI ────────────────────────────────────────
			if (settings.length === 0) {
				ctx.ui.notify("No extension settings registered.", "info");
				return;
			}
			if (ctx.mode !== "tui") {
				const lines = settings.map((s) => `${s.id} = ${s.get()}`).join("\n");
				ctx.ui.notify(`Settings:\n${lines}`, "info");
				return;
			}

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = sortedSettings().map((s) => ({
					id: s.id,
					label: s.label,
					currentValue: s.get(),
					values: s.values,
				}));

				const container = new Container();
				container.addChild(new Text(theme.fg("accent", theme.bold(" Config ")), 1, 1));

				const list = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						const setting = registry().get(id);
						if (setting) setting.set(newValue);
					},
					() => done(undefined),
					{ enableSearch: true },
				);
				container.addChild(list);

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						list.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
		},
	});
}
