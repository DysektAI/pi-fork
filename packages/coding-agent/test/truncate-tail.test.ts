import { describe, expect, it } from "vitest";
import { truncateTail } from "../src/core/tools/truncate.ts";

describe("truncateTail limit classification", () => {
	it("reports bytes when a partial last line also fills the line limit", () => {
		const result = truncateTail("previous\nééé", { maxLines: 1, maxBytes: 5 });
		expect(result.content).toBe("éé");
		expect(result.truncatedBy).toBe("bytes");
		expect(result.lastLinePartial).toBe(true);
	});

	it("reports lines when a complete last line fits the byte limit", () => {
		const result = truncateTail("previous\néé", { maxLines: 1, maxBytes: 5 });
		expect(result.content).toBe("éé");
		expect(result.truncatedBy).toBe("lines");
		expect(result.lastLinePartial).toBe(false);
	});
});
