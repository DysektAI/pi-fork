import { describe, expect, it } from "vitest";
import { extractOutline, renderOutline } from "../src/core/tools/read-outline.ts";

describe("extractOutline", () => {
	it("extracts top-level and nested declarations from TypeScript", () => {
		const src = [
			"import { foo } from './foo';",
			"",
			"export function alpha(a: number): number {",
			"  return a + 1;",
			"}",
			"",
			"export class Widget {",
			"  private count = 0;",
			"  increment(): void {",
			"    this.count++;",
			"  }",
			"}",
			"",
			"export const beta = (x: string) => x.length;",
			"interface Shape {",
			"  area(): number;",
			"}",
		].join("\n");

		const result = extractOutline(src, "typescript");
		const texts = result.entries.map((e) => e.text);

		expect(result.family).toBe("c-like");
		expect(texts).toContain("export function alpha(a: number): number");
		expect(texts).toContain("export class Widget");
		expect(texts).toContain("increment(): void");
		expect(texts).toContain("export const beta = (x: string) => x.length;");
		expect(texts).toContain("interface Shape");
	});

	it("records 1-indexed line numbers and nesting depth", () => {
		const src = ["class A {", "  method() {", "    return 1;", "  }", "}"].join("\n");
		const result = extractOutline(src, "typescript");

		const classEntry = result.entries.find((e) => e.text === "class A");
		const methodEntry = result.entries.find((e) => e.text === "method()");
		expect(classEntry).toEqual({ line: 1, depth: 0, text: "class A" });
		expect(methodEntry?.line).toBe(2);
		expect(methodEntry?.depth).toBeGreaterThan(0);
	});

	it("does not treat control-flow keywords as declarations", () => {
		const src = [
			"function run() {",
			"  if (x) {",
			"    doThing();",
			"  }",
			"  for (let i = 0; i < 3; i++) {",
			"    loop();",
			"  }",
			"}",
		].join("\n");
		const result = extractOutline(src, "typescript");
		const texts = result.entries.map((e) => e.text);
		expect(texts).toContain("function run()");
		expect(texts.some((t) => t.startsWith("if"))).toBe(false);
		expect(texts.some((t) => t.startsWith("for"))).toBe(false);
	});

	it("extracts Python defs and classes", () => {
		const src = ["class Foo:", "    def bar(self):", "        return 1", "", "def top():", "    pass"].join("\n");
		const result = extractOutline(src, "python");
		const texts = result.entries.map((e) => e.text);
		expect(result.family).toBe("python");
		expect(texts).toContain("class Foo:");
		expect(texts).toContain("def bar(self):");
		expect(texts).toContain("def top():");
	});

	it("extracts Go funcs and types", () => {
		const src = ["package main", "", "type User struct {", "  Name string", "}", "", "func main() {", "}"].join("\n");
		const result = extractOutline(src, "go");
		const texts = result.entries.map((e) => e.text);
		expect(result.family).toBe("go");
		expect(texts).toContain("type User struct");
		expect(texts).toContain("func main()");
	});

	it("extracts Rust items", () => {
		const src = ["pub struct Point {", "  x: i32,", "}", "", "pub fn dist() -> f64 {", "  0.0", "}"].join("\n");
		const result = extractOutline(src, "rust");
		const texts = result.entries.map((e) => e.text);
		expect(result.family).toBe("rust");
		expect(texts).toContain("pub struct Point");
		expect(texts).toContain("pub fn dist() -> f64");
	});

	it("returns no entries for unsupported languages", () => {
		const result = extractOutline("key: value\nother: 1\n", "yaml");
		expect(result.family).toBeUndefined();
		expect(result.entries).toEqual([]);
	});

	it("renders a header and elision notice", () => {
		const src = ["export function only() {", "  return 1;", "}"].join("\n");
		const result = extractOutline(src, "typescript");
		const text = renderOutline(result, { path: "foo.ts", totalLines: 3 });
		expect(text).toContain("Outline of foo.ts (3 lines, 1 symbol):");
		expect(text).toContain("export function only()");
		expect(text).toContain("bodies elided");
	});
});
