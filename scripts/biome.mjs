import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

// Biome 2.3.x crashes (0xC0000005) on Windows when the GritQL plugin lints on many worker threads:
// 32 threads crashed every run, 16 or fewer never did. Biome has no thread flag, so cap its Rayon pool.
// Drop this wrapper once the repo uses Biome 2.4.0+, which does not crash.
const env = { ...process.env };
if (process.platform === "win32" && !env.RAYON_NUM_THREADS) env.RAYON_NUM_THREADS = "8";
const biome = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
const result = spawnSync(process.execPath, [biome, ...process.argv.slice(2)], { env, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
