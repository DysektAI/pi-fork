import assert from "node:assert";
import { describe, it } from "node:test";
import { KillRing } from "../src/kill-ring.ts";

describe("KillRing", () => {
	it("starts empty", () => {
		const ring = new KillRing();
		assert.strictEqual(ring.length, 0);
		assert.strictEqual(ring.peek(), undefined);
	});

	it("push adds entries", () => {
		const ring = new KillRing();
		ring.push("hello", { prepend: false });
		assert.strictEqual(ring.length, 1);
		assert.strictEqual(ring.peek(), "hello");
	});

	it("ignores empty strings", () => {
		const ring = new KillRing();
		ring.push("", { prepend: false });
		assert.strictEqual(ring.length, 0);
	});

	it("peek returns most recent entry", () => {
		const ring = new KillRing();
		ring.push("first", { prepend: false });
		ring.push("second", { prepend: false });
		assert.strictEqual(ring.peek(), "second");
	});

	it("accumulate appends to last entry", () => {
		const ring = new KillRing();
		ring.push("hello", { prepend: false });
		ring.push(" world", { prepend: false, accumulate: true });
		assert.strictEqual(ring.length, 1);
		assert.strictEqual(ring.peek(), "hello world");
	});

	it("accumulate prepends when prepend is true", () => {
		const ring = new KillRing();
		ring.push("world", { prepend: false });
		ring.push("hello ", { prepend: true, accumulate: true });
		assert.strictEqual(ring.length, 1);
		assert.strictEqual(ring.peek(), "hello world");
	});

	it("accumulate on empty ring just pushes", () => {
		const ring = new KillRing();
		ring.push("text", { prepend: false, accumulate: true });
		assert.strictEqual(ring.length, 1);
		assert.strictEqual(ring.peek(), "text");
	});

	it("rotate moves last entry to front", () => {
		const ring = new KillRing();
		ring.push("a", { prepend: false });
		ring.push("b", { prepend: false });
		ring.push("c", { prepend: false });
		assert.strictEqual(ring.peek(), "c");

		ring.rotate();
		assert.strictEqual(ring.peek(), "b");

		ring.rotate();
		assert.strictEqual(ring.peek(), "a");
	});

	it("rotate with single entry is a no-op", () => {
		const ring = new KillRing();
		ring.push("only", { prepend: false });
		ring.rotate();
		assert.strictEqual(ring.peek(), "only");
		assert.strictEqual(ring.length, 1);
	});

	it("rotate with empty ring is a no-op", () => {
		const ring = new KillRing();
		ring.rotate();
		assert.strictEqual(ring.length, 0);
	});
});
