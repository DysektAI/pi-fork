import os from "node:os";

/**
 * Shared Vitest pool sizing for the monorepo.
 *
 * The default pool spawns one worker per CPU. On high-core machines (and
 * especially under WSL) that can launch dozens of workers, each of which may
 * spawn its own child processes (clipboard `spawnSync`, network E2E, browser
 * smoke checks). The resulting process/IO storm can hang or crash the host even
 * when memory is plentiful.
 *
 * To keep local runs safe while letting CI opt back into full parallelism, the
 * fork count is capped at a conservative default and can be overridden with the
 * `VITEST_MAX_FORKS` environment variable (set it to `0` to use every core).
 */

const DEFAULT_MAX_FORKS = 4;

function availableCpus() {
	if (typeof os.availableParallelism === "function") {
		return os.availableParallelism();
	}
	return os.cpus()?.length ?? 1;
}

/**
 * Resolve the maximum number of Vitest fork workers to use.
 *
 * @returns {number} A worker count >= 1, never exceeding the available CPUs.
 */
export function resolveMaxForks() {
	const cpus = Math.max(1, availableCpus());
	const raw = process.env.VITEST_MAX_FORKS;

	if (raw !== undefined && raw.trim() !== "") {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed)) {
			// VITEST_MAX_FORKS=0 means "use every core" (CI opt-out of the cap).
			if (parsed <= 0) {
				return cpus;
			}
			return Math.min(parsed, cpus);
		}
	}

	return Math.min(DEFAULT_MAX_FORKS, cpus);
}

/**
 * Build the bounded-concurrency slice of a Vitest config. Spread the result
 * into a Vitest `test` block.
 *
 * Vitest 4 removed `poolOptions.forks.{maxForks,minForks}` in favor of the
 * top-level `maxWorkers`/`minWorkers` options (see the v4 "Pool Rework"
 * migration). We keep `pool: "forks"` and cap workers via `maxWorkers`.
 *
 * @returns {{ pool: "forks", maxWorkers: number, minWorkers: number }}
 */
export function boundedForkPool() {
	const maxForks = resolveMaxForks();
	return {
		pool: "forks",
		maxWorkers: maxForks,
		minWorkers: 1,
	};
}
