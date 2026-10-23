import { describe, expect, it, vi } from "vitest";
import { lazyStream } from "../src/api/lazy.ts";
import { fauxProvider } from "../src/providers/faux.ts";
import type { AssistantMessageEvent } from "../src/types.ts";

// DysektAI/pi-fork#40: upstream observation and fork setup timing must coexist.
describe("fork sync lazy stream integration", () => {
	it("keeps the setup timestamp and reports its failure to observers once", async () => {
		const model = fauxProvider().provider.getModels()[0];
		const onEvent = vi.fn();
		const onResult = vi.fn();
		const clock = vi.spyOn(Date, "now").mockReturnValue(100);
		try {
			const stream = lazyStream(
				model,
				async () => {
					clock.mockReturnValue(101);
					throw new Error("setup failed");
				},
				{ onEvent, onResult },
			);
			const events: AssistantMessageEvent[] = [];
			for await (const event of stream) events.push(event);
			const result = await stream.result();

			expect(result.timestamp).toBe(100);
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
			expect(result.errorMessage).toBe("setup failed");
			expect(events).toEqual([{ type: "error", reason: "error", error: result }]);
			expect(onEvent).toHaveBeenCalledExactlyOnceWith(events[0]);
			expect(onResult).toHaveBeenCalledExactlyOnceWith(result);
		} finally {
			clock.mockRestore();
		}
	});
});
