import { describe, expect, it } from "vitest";
import {
	BRANCH_SUMMARY_PREFIX,
	BRANCH_SUMMARY_SUFFIX,
	bashExecutionToText,
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../../src/harness/messages.ts";
import type { AgentMessage } from "../../src/types.ts";

describe("bashExecutionToText", () => {
	it("renders command with output", () => {
		const result = bashExecutionToText({
			role: "bashExecution",
			command: "ls -la",
			output: "file1.txt\nfile2.txt",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
		});
		expect(result).toContain("Ran `ls -la`");
		expect(result).toContain("file1.txt\nfile2.txt");
		expect(result).toContain("```");
	});

	it("renders no output message", () => {
		const result = bashExecutionToText({
			role: "bashExecution",
			command: "touch foo",
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
		});
		expect(result).toContain("(no output)");
	});

	it("indicates cancellation", () => {
		const result = bashExecutionToText({
			role: "bashExecution",
			command: "sleep 100",
			output: "",
			exitCode: undefined,
			cancelled: true,
			truncated: false,
			timestamp: Date.now(),
		});
		expect(result).toContain("(command cancelled)");
	});

	it("shows non-zero exit code", () => {
		const result = bashExecutionToText({
			role: "bashExecution",
			command: "false",
			output: "error",
			exitCode: 1,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
		});
		expect(result).toContain("exited with code 1");
	});

	it("shows truncation notice with full output path", () => {
		const result = bashExecutionToText({
			role: "bashExecution",
			command: "cat bigfile",
			output: "partial...",
			exitCode: 0,
			cancelled: false,
			truncated: true,
			fullOutputPath: "/tmp/bash-123.log",
			timestamp: Date.now(),
		});
		expect(result).toContain("Output truncated");
		expect(result).toContain("/tmp/bash-123.log");
	});

	it("does not show exit code for zero or null", () => {
		const result = bashExecutionToText({
			role: "bashExecution",
			command: "echo hi",
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
		});
		expect(result).not.toContain("exited with code");
	});
});

describe("createBranchSummaryMessage", () => {
	it("creates a branch summary with correct fields", () => {
		const msg = createBranchSummaryMessage("branch summary text", "entry-123", "2024-01-15T10:00:00.000Z");
		expect(msg.role).toBe("branchSummary");
		expect(msg.summary).toBe("branch summary text");
		expect(msg.fromId).toBe("entry-123");
		expect(msg.timestamp).toBe(new Date("2024-01-15T10:00:00.000Z").getTime());
	});
});

describe("createCompactionSummaryMessage", () => {
	it("creates a compaction summary with correct fields", () => {
		const msg = createCompactionSummaryMessage("compacted content", 5000, "2024-06-01T12:00:00.000Z");
		expect(msg.role).toBe("compactionSummary");
		expect(msg.summary).toBe("compacted content");
		expect(msg.tokensBefore).toBe(5000);
		expect(msg.timestamp).toBe(new Date("2024-06-01T12:00:00.000Z").getTime());
	});
});

describe("createCustomMessage", () => {
	it("creates a custom message with string content", () => {
		const msg = createCustomMessage("myType", "hello", true, { extra: 1 }, "2024-03-01T00:00:00.000Z");
		expect(msg.role).toBe("custom");
		expect(msg.customType).toBe("myType");
		expect(msg.content).toBe("hello");
		expect(msg.display).toBe(true);
		expect(msg.details).toEqual({ extra: 1 });
		expect(msg.timestamp).toBe(new Date("2024-03-01T00:00:00.000Z").getTime());
	});

	it("creates a custom message with array content", () => {
		const content = [{ type: "text" as const, text: "hello" }];
		const msg = createCustomMessage("info", content, false, undefined, "2024-03-01T00:00:00.000Z");
		expect(msg.content).toEqual(content);
		expect(msg.display).toBe(false);
		expect(msg.details).toBeUndefined();
	});
});

describe("convertToLlm", () => {
	it("converts bashExecution to user message", () => {
		const messages: AgentMessage[] = [
			{
				role: "bashExecution",
				command: "echo hi",
				output: "hi",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1000,
			},
		];
		const result = convertToLlm(messages);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("user");
	});

	it("excludes bashExecution with excludeFromContext", () => {
		const messages: AgentMessage[] = [
			{
				role: "bashExecution",
				command: "echo hi",
				output: "hi",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1000,
				excludeFromContext: true,
			},
		];
		const result = convertToLlm(messages);
		expect(result).toHaveLength(0);
	});

	it("converts branchSummary with prefix and suffix", () => {
		const messages: AgentMessage[] = [
			{
				role: "branchSummary",
				summary: "branch content",
				fromId: "id-1",
				timestamp: 1000,
			},
		];
		const result = convertToLlm(messages);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("user");
		const text = (result[0].content as Array<{ type: string; text: string }>)[0].text;
		expect(text).toContain(BRANCH_SUMMARY_PREFIX);
		expect(text).toContain("branch content");
		expect(text).toContain(BRANCH_SUMMARY_SUFFIX);
	});

	it("converts compactionSummary with prefix and suffix", () => {
		const messages: AgentMessage[] = [
			{
				role: "compactionSummary",
				summary: "compaction content",
				tokensBefore: 3000,
				timestamp: 2000,
			},
		];
		const result = convertToLlm(messages);
		expect(result).toHaveLength(1);
		const text = (result[0].content as Array<{ type: string; text: string }>)[0].text;
		expect(text).toContain(COMPACTION_SUMMARY_PREFIX);
		expect(text).toContain("compaction content");
		expect(text).toContain(COMPACTION_SUMMARY_SUFFIX);
	});

	it("passes through user and assistant messages", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "hello", timestamp: 1000 },
			{
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "openai-completions",
				provider: "openai",
				model: "gpt-4o",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2000,
			},
		];
		const result = convertToLlm(messages);
		expect(result).toHaveLength(2);
		expect(result[0].role).toBe("user");
		expect(result[1].role).toBe("assistant");
	});

	it("converts custom message with string content", () => {
		const messages: AgentMessage[] = [
			{
				role: "custom",
				customType: "note",
				content: "some text",
				display: true,
				timestamp: 1000,
			},
		];
		const result = convertToLlm(messages);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("user");
		const content = result[0].content as Array<{ type: string; text: string }>;
		expect(content[0].text).toBe("some text");
	});
});
