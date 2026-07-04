import { describe, expect, it } from "vitest";
import { sanitizeBinaryOutput } from "../../src/harness/utils/shell-output.ts";

describe("sanitizeBinaryOutput", () => {
	it("passes through normal text unchanged", () => {
		expect(sanitizeBinaryOutput("hello world")).toBe("hello world");
	});

	it("preserves tabs, newlines, and carriage returns", () => {
		expect(sanitizeBinaryOutput("line1\nline2\ttab\rreturn")).toBe("line1\nline2\ttab\rreturn");
	});

	it("removes null bytes", () => {
		expect(sanitizeBinaryOutput("a\x00b")).toBe("ab");
	});

	it("removes control characters (except tab/newline/cr)", () => {
		expect(sanitizeBinaryOutput("a\x01\x02\x03b")).toBe("ab");
		expect(sanitizeBinaryOutput("a\x1fb")).toBe("ab");
	});

	it("preserves printable ASCII", () => {
		const printable =
			" !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
		expect(sanitizeBinaryOutput(printable)).toBe(printable);
	});

	it("removes interlinear annotation characters (U+FFF9-U+FFFB)", () => {
		expect(sanitizeBinaryOutput("a\uFFF9b\uFFFAc\uFFFBd")).toBe("abcd");
	});

	it("preserves unicode text", () => {
		const unicode = "Hello 世界 🌍";
		expect(sanitizeBinaryOutput(unicode)).toBe(unicode);
	});

	it("handles empty string", () => {
		expect(sanitizeBinaryOutput("")).toBe("");
	});

	it("handles string of only control characters", () => {
		expect(sanitizeBinaryOutput("\x00\x01\x02\x03")).toBe("");
	});
});
