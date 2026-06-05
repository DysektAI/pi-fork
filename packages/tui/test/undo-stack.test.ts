import assert from "node:assert";
import { describe, it } from "node:test";
import { UndoStack } from "../src/undo-stack.ts";

describe("UndoStack", () => {
	it("starts empty", () => {
		const stack = new UndoStack<string>();
		assert.strictEqual(stack.length, 0);
		assert.strictEqual(stack.pop(), undefined);
	});

	it("push and pop work in LIFO order", () => {
		const stack = new UndoStack<string>();
		stack.push("a");
		stack.push("b");
		stack.push("c");
		assert.strictEqual(stack.length, 3);
		assert.strictEqual(stack.pop(), "c");
		assert.strictEqual(stack.pop(), "b");
		assert.strictEqual(stack.pop(), "a");
		assert.strictEqual(stack.length, 0);
	});

	it("push stores a deep clone", () => {
		const stack = new UndoStack<{ value: number }>();
		const obj = { value: 1 };
		stack.push(obj);
		obj.value = 99;
		const popped = stack.pop();
		assert.strictEqual(popped?.value, 1);
	});

	it("clear removes all entries", () => {
		const stack = new UndoStack<number>();
		stack.push(1);
		stack.push(2);
		stack.push(3);
		assert.strictEqual(stack.length, 3);
		stack.clear();
		assert.strictEqual(stack.length, 0);
		assert.strictEqual(stack.pop(), undefined);
	});

	it("handles complex nested objects", () => {
		const stack = new UndoStack<{ arr: number[]; nested: { x: string } }>();
		const state = { arr: [1, 2, 3], nested: { x: "hello" } };
		stack.push(state);
		state.arr.push(4);
		state.nested.x = "changed";
		const popped = stack.pop();
		assert.deepStrictEqual(popped, { arr: [1, 2, 3], nested: { x: "hello" } });
	});
});
