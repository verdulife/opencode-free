import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import extension, { createFileOps } from "../extensions/opencode-free.ts";

/**
 * Contract tests for the two hooks that hand a summary back to pi.
 *
 * Pi reads `result.compaction.summary` for compaction and `result.summary.summary`
 * for a branch summary, so an extra level of nesting silently stores an object
 * where pi expects text. These tests pin both shapes, the request body the free
 * tier requires, and the yield-to-pi fallback.
 */

type Handler = (event: any, ctx: any) => any;

function harness() {
	const handlers = new Map<string, Handler[]>();
	const notifications: string[] = [];
	const pi = new Proxy(
		{},
		{
			get(_target, property: string) {
				if (property === "on") {
					return (event: string, handler: Handler) => {
						const list = handlers.get(event) ?? [];
						list.push(handler);
						handlers.set(event, list);
					};
				}
				if (property === "getSettings") return () => ({});
				return () => {};
			},
		},
	);
	(extension as unknown as (pi: unknown) => void)(pi);
	const ctx = {
		model: { provider: "opencode", id: "big-pickle" },
		ui: { notify: (message: string) => notifications.push(message) },
	};
	return { handlers, notifications, ctx };
}

function handlerFor(handlers: Map<string, Handler[]>, event: string): Handler {
	const list = handlers.get(event);
	assert.ok(list && list.length > 0, `${event} should be registered`);
	return list[0];
}

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function sse(summary: string): Response {
	const frames =
		`data: ${JSON.stringify({ choices: [{ delta: { content: summary } }] })}\n\n` +
		`data: ${JSON.stringify({ choices: [], usage: { inputTokens: 11, outputTokens: 22 } })}\n\n` +
		"data: [DONE]\n\n";
	return new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function userMessage(text: string) {
	return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

const signal = () => new AbortController().signal;

test("session_before_tree hands pi a text summary, not a nested object", async () => {
	const requests: RequestInit[] = [];
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		requests.push(init);
		return sse("## Goal\nFinish the report.\n\n## Next Steps\n1. Ship it.");
	}) as unknown as typeof fetch;

	const { handlers, ctx } = harness();
	const event = {
		type: "session_before_tree",
		preparation: {
			targetId: "t1",
			oldLeafId: "l1",
			commonAncestorId: null,
			entriesToSummarize: [userMessage("explore the other branch")],
			userWantsSummary: true,
		},
		signal: signal(),
	};
	const result = await handlerFor(handlers, "session_before_tree")(event, ctx);

	assert.ok(result, "the handler should take over on a free model");
	assert.deepEqual(Object.keys(result.summary).sort(), ["details", "summary", "usage"]);
	assert.equal(typeof result.summary.summary, "string", "pi reads result.summary.summary as the text");
	assert.ok(
		result.summary.summary.startsWith("The user explored a different conversation branch before returning here."),
		"the branch preamble is kept",
	);
	assert.match(result.summary.summary, /## Goal/);
	assert.ok(result.summary.usage, "usage is forwarded so pi can account for it");

	const body = JSON.parse(requests[0].body as string);
	assert.equal(body.stream, true);
	assert.deepEqual(
		body.tools.map((tool: { function: { name: string } }) => tool.function.name),
		["read", "bash"],
		"the request carries the two tools the gate looks for",
	);
});

test("session_before_tree reports the files the branch touched", async () => {
	globalThis.fetch = (async () => sse("## Goal\nNothing.")) as unknown as typeof fetch;
	const { handlers, ctx } = harness();
	const event = {
		type: "session_before_tree",
		preparation: {
			targetId: "t1",
			oldLeafId: "l1",
			commonAncestorId: null,
			entriesToSummarize: [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "toolCall", name: "read", arguments: { path: "notes.md" } },
							{ type: "toolCall", name: "edit", arguments: { path: "report.md" } },
						],
					},
				},
			],
			userWantsSummary: true,
		},
		signal: signal(),
	};
	const result = await handlerFor(handlers, "session_before_tree")(event, ctx);

	assert.deepEqual(result.summary.details, { readFiles: ["notes.md"], modifiedFiles: ["report.md"] });
	assert.match(result.summary.summary, /<read-files>\nnotes\.md\n<\/read-files>/);
	assert.match(result.summary.summary, /<modified-files>\nreport\.md\n<\/modified-files>/);
});

test("session_before_compact hands pi a complete compaction result", async () => {
	globalThis.fetch = (async () => sse("## Goal\nFinish the report.")) as unknown as typeof fetch;
	const { handlers, ctx } = harness();
	const fileOps = createFileOps();
	fileOps.read.add("notes.md");
	const event = {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "keep-me",
			tokensBefore: 1234,
			messagesToSummarize: [userMessage("what happened so far")],
			turnPrefixMessages: [],
			isSplitTurn: false,
			fileOps,
			settings: { reserveTokens: 16_000 },
		},
		signal: signal(),
	};
	const result = await handlerFor(handlers, "session_before_compact")(event, ctx);

	assert.ok(result, "the handler should take over on a free model");
	assert.deepEqual(Object.keys(result), ["compaction"]);
	assert.equal(typeof result.compaction.summary, "string");
	assert.equal(result.compaction.firstKeptEntryId, "keep-me", "pi throws without this");
	assert.equal(result.compaction.tokensBefore, 1234);
	assert.deepEqual(result.compaction.details, { readFiles: ["notes.md"], modifiedFiles: [] });
	assert.ok(result.compaction.usage);
});

test("session_before_compact merges a split turn into one summary", async () => {
	const answers = ["## Goal\nHistory.", "## Original Request\nSplit turn work."];
	let call = 0;
	globalThis.fetch = (async () => sse(answers[call++])) as unknown as typeof fetch;
	const { handlers, ctx } = harness();
	const preparation = {
		firstKeptEntryId: "keep-me",
		tokensBefore: 999,
		messagesToSummarize: [userMessage("history")],
		turnPrefixMessages: [userMessage("the turn being split")],
		isSplitTurn: true,
		fileOps: createFileOps(),
		settings: { reserveTokens: 16_000 },
	};
	const result = await handlerFor(handlers, "session_before_compact")(
		{ type: "session_before_compact", preparation, signal: signal() },
		ctx,
	);

	assert.equal(call, 2, "the split turn costs a second call");
	assert.match(result.compaction.summary, /## Goal\nHistory\./);
	assert.match(result.compaction.summary, /\*\*Turn Context \(split turn\):\*\*/);
	assert.match(result.compaction.summary, /## Original Request\nSplit turn work\./);
});

test("a failing summarization notifies and yields to pi instead of cancelling", async () => {
	globalThis.fetch = (async () =>
		new Response('{"type":"FreeTierError","message":"only from within OpenCode"}', { status: 403 })) as unknown as typeof fetch;
	const { handlers, ctx, notifications } = harness();
	const preparation = {
		targetId: "t1",
		oldLeafId: "l1",
		commonAncestorId: null,
		entriesToSummarize: [userMessage("anything")],
		userWantsSummary: true,
	};

	const branch = await handlerFor(handlers, "session_before_tree")(
		{ type: "session_before_tree", preparation, signal: signal() },
		ctx,
	);
	assert.equal(branch, undefined, "pi must be free to run its own attempt");
	assert.equal(notifications.length, 1);
	assert.match(notifications[0], /403/);

	const compaction = await handlerFor(handlers, "session_before_compact")(
		{
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "k",
				tokensBefore: 1,
				messagesToSummarize: [userMessage("anything")],
				turnPrefixMessages: [],
				isSplitTurn: false,
				fileOps: createFileOps(),
				settings: {},
			},
			signal: signal(),
		},
		ctx,
	);
	assert.equal(compaction, undefined);
	assert.equal(notifications.length, 2);
});

test("an aborted signal yields silently and never notifies", async () => {
	globalThis.fetch = (async () => {
		throw new Error("aborted");
	}) as unknown as typeof fetch;
	const { handlers, ctx, notifications } = harness();
	const controller = new AbortController();
	controller.abort();
	const result = await handlerFor(handlers, "session_before_tree")(
		{
			type: "session_before_tree",
			preparation: {
				targetId: "t1",
				oldLeafId: "l1",
				commonAncestorId: null,
				entriesToSummarize: [userMessage("anything")],
				userWantsSummary: true,
			},
			signal: controller.signal,
		},
		ctx,
	);
	assert.equal(result, undefined);
	assert.deepEqual(notifications, []);
});

test("models from other providers are left to pi untouched", async () => {
	let called = 0;
	globalThis.fetch = (async () => {
		called++;
		return sse("never used");
	}) as unknown as typeof fetch;
	const { handlers, ctx } = harness();
	const foreign = { ...ctx, model: { provider: "anthropic", id: "claude-sonnet-4-5" } };
	const preparation = {
		targetId: "t1",
		oldLeafId: "l1",
		commonAncestorId: null,
		entriesToSummarize: [userMessage("anything")],
		userWantsSummary: true,
	};

	const result = await handlerFor(handlers, "session_before_tree")(
		{ type: "session_before_tree", preparation, signal: signal() },
		foreign,
	);
	assert.equal(result, undefined);
	assert.equal(called, 0, "no request is made for a model this extension does not serve");
});
