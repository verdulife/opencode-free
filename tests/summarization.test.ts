import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	GATE_TOOLS,
	SUMMARIZATION_PROMPT,
	UPDATE_SUMMARIZATION_PROMPT,
	buildBranchPrompt,
	buildCompactionPrompt,
	buildSummarizationBody,
	buildTurnPrefixPrompt,
	computeFileLists,
	createFileOps,
	createStreamCollector,
	extractFileOpsFromMessage,
	formatFileOperations,
	prepareBranchMessages,
	serializeMessages,
	truncateForSummary,
} from "../extensions/opencode-free.ts";

// --- The gate contract -------------------------------------------------------
//
// The free-tier gateway accepts a summarization request only with EID-shaped
// identifiers, `stream: true` and tools named exactly `read` and `bash`. The id
// shape is covered by fingerprint.test.ts; these tests pin the body.

test("summarization body carries what the free-tier gate requires", () => {
	const body = buildSummarizationBody({ model: "big-pickle", promptText: "summarize this" });

	assert.equal(body.model, "big-pickle");
	assert.equal(body.stream, true, "the gate rejects a request without stream: true");

	const tools = body.tools as { type: string; function: { name: string; parameters: { type: string } } }[];
	assert.deepEqual(
		tools.map((tool) => tool.function.name),
		[...GATE_TOOLS],
		"the gate looks for tools named read and bash",
	);
	for (const tool of tools) {
		assert.equal(tool.type, "function");
		assert.equal(tool.function.parameters.type, "object");
	}

	const messages = body.messages as { role: string; content: unknown }[];
	assert.equal(messages[0].role, "system");
	assert.equal(messages[1].role, "user");
	assert.ok(Array.isArray(messages[1].content), "user content stays in the array-of-parts shape Pi uses");
	assert.equal((messages[1].content as { type: string; text: string }[])[0].text, "summarize this");
});

test("max_completion_tokens is optional and only set when asked for", () => {
	const without = buildSummarizationBody({ model: "m", promptText: "p" });
	assert.ok(!("max_completion_tokens" in without));

	const withBudget = buildSummarizationBody({ model: "m", promptText: "p", maxOutputTokens: 2048.7 });
	assert.equal(withBudget.max_completion_tokens, 2048);

	const invalid = buildSummarizationBody({ model: "m", promptText: "p", maxOutputTokens: 0 });
	assert.ok(!("max_completion_tokens" in invalid));
});

// --- SSE parsing -------------------------------------------------------------

function sse(delta: string): string {
	return `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
}

test("stream collector joins deltas, captures usage and stops at [DONE]", () => {
	const collector = createStreamCollector();
	collector.push(sse("Hello "));
	collector.push(sse("world"));
	assert.equal(collector.settled(), false);

	collector.push(`data: ${JSON.stringify({ choices: [], usage: { inputTokens: 7, outputTokens: 3 } })}\n\n`);
	collector.push("data: [DONE]\n\n");
	assert.equal(collector.settled(), true);

	const result = collector.finish();
	assert.equal(result.text, "Hello world");
	assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3 });
});

test("stream collector reassembles frames split across chunks", () => {
	const collector = createStreamCollector();
	const frame = sse("split");
	collector.push(frame.slice(0, 12));
	collector.push(frame.slice(12));
	collector.push("data: [DONE]\n\n");
	assert.equal(collector.finish().text, "split");
});

test("stream collector ignores malformed frames and non-data lines", () => {
	const collector = createStreamCollector();
	collector.push(": keep-alive comment\n");
	collector.push("data: {not json\n\n");
	collector.push(sse("survives"));
	collector.push("data: [DONE]\n\n");
	assert.equal(collector.finish().text, "survives");
});

test("stream collector falls back to a plain JSON body", () => {
	const collector = createStreamCollector();
	collector.push(
		JSON.stringify({ choices: [{ message: { content: "plain answer" } }], usage: { outputTokens: 2 } }),
	);
	const result = collector.finish();
	assert.equal(result.text, "plain answer");
	assert.deepEqual(result.usage, { outputTokens: 2 });
});

// --- Message serialization ---------------------------------------------------

test("serializeMessages renders each role the way pi does", () => {
	const text = serializeMessages([
		{ role: "user", content: [{ type: "text", text: "hola" }] },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "pensando" },
				{ type: "text", text: "vale" },
				{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
			],
		},
		{ role: "toolResult", content: [{ type: "text", text: "contenido" }] },
	]);

	assert.match(text, /\[User\]: hola/);
	assert.match(text, /\[Assistant thinking\]: pensando/);
	assert.match(text, /\[Assistant\]: vale/);
	assert.match(text, /\[Assistant tool calls\]: read\(path="a\.ts"\)/);
	assert.match(text, /\[Tool result\]: contenido/);
});

test("serializeMessages ignores messages it cannot read and blank users", () => {
	assert.equal(serializeMessages([{ role: "user", content: "" }]), "");
	assert.equal(serializeMessages([{ role: "system", content: "ignored" }]), "");
	assert.equal(serializeMessages([{ role: "user", content: [{ type: "image" }] }]), "[User]: [image]");
});

test("tool results are truncated for summarization", () => {
	const long = "x".repeat(2500);
	const text = serializeMessages([{ role: "toolResult", content: [{ type: "text", text: long }] }]);
	assert.match(text, /more characters truncated\]/);
	assert.ok(text.length < long.length, "truncation must shorten the payload");

	assert.equal(truncateForSummary("short", 10), "short");
});

// --- File tracking -----------------------------------------------------------

test("computeFileLists splits read-only files from modified ones", () => {
	const fileOps = createFileOps();
	fileOps.read.add("b.ts");
	fileOps.read.add("a.ts");
	fileOps.read.add("edited.ts");
	fileOps.edited.add("edited.ts");
	fileOps.written.add("new.ts");

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	assert.deepEqual(readFiles, ["a.ts", "b.ts"]);
	assert.deepEqual(modifiedFiles, ["edited.ts", "new.ts"]);
});

test("formatFileOperations emits tags only for non-empty lists", () => {
	assert.equal(formatFileOperations([], []), "");
	assert.equal(formatFileOperations(["a.ts"], []), "\n\n<read-files>\na.ts\n</read-files>");
	assert.equal(formatFileOperations([], ["b.ts"]), "\n\n<modified-files>\nb.ts\n</modified-files>");
	assert.match(formatFileOperations(["a.ts"], ["b.ts"]), /<\/read-files>\n\n<modified-files>/);
});

test("extractFileOpsFromMessage reads tool calls and nested codemode calls", () => {
	const fileOps = createFileOps();
	extractFileOpsFromMessage(
		{
			role: "assistant",
			content: [
				{ type: "toolCall", name: "read", arguments: { path: "read.ts" } },
				{ type: "toolCall", name: "edit", arguments: { path: "edited.ts" } },
				{ type: "toolCall", name: "write", arguments: { path: "written.ts" } },
				{ type: "toolCall", name: "read", arguments: {} },
			],
		},
		fileOps,
	);
	extractFileOpsFromMessage(
		{ role: "toolResult", content: [], nestedCalls: { calls: [{ name: "read", arguments: { path: "nested.ts" } }] } },
		fileOps,
	);

	assert.deepEqual([...fileOps.read].sort(), ["nested.ts", "read.ts"]);
	assert.deepEqual([...fileOps.edited], ["edited.ts"]);
	assert.deepEqual([...fileOps.written], ["written.ts"]);
});

// --- Prompts -----------------------------------------------------------------

const CONVERSATION = [{ role: "user", content: [{ type: "text", text: "hola" }] }];

test("compaction prompt switches to the update variant when a summary exists", () => {
	const initial = buildCompactionPrompt(CONVERSATION);
	assert.ok(initial.includes(SUMMARIZATION_PROMPT));
	assert.ok(initial.startsWith("<conversation>\n[User]: hola\n</conversation>"));
	assert.ok(!initial.includes("<previous-summary>"));

	const update = buildCompactionPrompt(CONVERSATION, "## Goal\nkeep going");
	assert.ok(update.includes(UPDATE_SUMMARIZATION_PROMPT));
	assert.ok(update.includes("<previous-summary>\n## Goal\nkeep going\n</previous-summary>"));
});

test("compaction prompt appends custom instructions without replacing the format", () => {
	const prompt = buildCompactionPrompt(CONVERSATION, undefined, "focus on the database");
	assert.ok(prompt.includes("Additional focus: focus on the database"));
	assert.ok(prompt.includes(SUMMARIZATION_PROMPT));
});

test("turn prefix prompt wraps the conversation with its own instructions", () => {
	const prompt = buildTurnPrefixPrompt(CONVERSATION);
	assert.ok(prompt.startsWith("# Conversation\n[User]: hola"));
	assert.ok(prompt.includes("# Instructions"));
	assert.ok(prompt.includes("## Original Request"));
});

test("branch prompt honours replaceInstructions", () => {
	const appended = buildBranchPrompt(CONVERSATION, "focus on the api");
	assert.ok(appended.includes("## Goal"));
	assert.ok(appended.includes("Additional focus: focus on the api"));

	const replaced = buildBranchPrompt(CONVERSATION, "only this instruction", true);
	assert.ok(replaced.endsWith("only this instruction"));
	assert.ok(!replaced.includes("## Goal"));
});

// --- Branch entries ----------------------------------------------------------

test("prepareBranchMessages converts entries and keeps cumulative file tracking", () => {
	const { messages, fileOps } = prepareBranchMessages([
		{ type: "branch_summary", fromHook: false, summary: "older branch", details: { readFiles: ["old.ts"], modifiedFiles: ["old-edited.ts"] } },
		{ type: "branch_summary", fromHook: true, summary: "hook branch", details: { readFiles: ["ignored.ts"] } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "nueva rama" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "leido.ts" } }] } },
		{ type: "custom_message", content: [{ type: "text", text: "custom" }] },
		{ type: "model_change", provider: "opencode", model: "big-pickle" },
	]);

	assert.equal(messages.length, 5, "model_change and other entries are skipped");
	assert.deepEqual([...fileOps.read].sort(), ["leido.ts", "old.ts"]);
	assert.deepEqual([...fileOps.edited], ["old-edited.ts"]);

	const text = serializeMessages(messages);
	assert.match(text, /\[Previous summary\]: older branch/);
	assert.match(text, /\[Previous summary\]: hook branch/);
	assert.match(text, /\[User\]: nueva rama/);
	assert.match(text, /\[User\]: custom/);
});

test("prepareBranchMessages tolerates an empty or unknown entry list", () => {
	assert.deepEqual(prepareBranchMessages([]).messages, []);
	assert.deepEqual(prepareBranchMessages([{ type: "unknown" } as Record<string, unknown>]).messages, []);
});
