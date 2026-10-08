import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	EID_PATTERN,
	applyFingerprintGuard,
	createEid,
	sanitizeHeaderValue,
	toModelSeeds,
} from "../extensions/opencode-free.ts";

const CLI_VERSION = "1.18.25";
const SESSION = "ses_1a11acf6af90tPeK65IrK5rwqs";
const REQUEST_PATTERN = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

function deps(sessionId = SESSION, projectHeader = "pi-agent") {
	return { sessionId, projectHeader, cliVersion: CLI_VERSION };
}

// --- EID shape ---------------------------------------------------------------

test("createEid mints opencode's EID shape for ses and msg", () => {
	for (const prefix of ["ses", "msg"] as const) {
		const id = createEid(prefix);
		assert.match(id, new RegExp(`^${prefix}_[0-9a-f]{12}[0-9A-Za-z]{14}$`));
		assert.equal(id.length, prefix.length + 1 + 12 + 14);
	}
});

test("createEid uses 12 hex chars derived from the timestamp", () => {
	const time = createEid("ses").slice(4, 16);
	assert.match(time, /^[0-9a-f]{12}$/);
	// The timestamp shifted by 12 bits dominates the encoded prefix.
	const expected = ((BigInt(Date.now()) * 0x1000n + 0xfffn) >> 8n).toString(16).padStart(12, "0");
	assert.equal(time.slice(0, 9), expected.slice(0, 9));
});

test("createEid never repeats itself", () => {
	const seen = new Set<string>();
	for (let i = 0; i < 2000; i += 1) seen.add(createEid("msg"));
	assert.equal(seen.size, 2000);
});

test("EID_PATTERN accepts the CLI shape and rejects everything else", () => {
	assert.ok(EID_PATTERN.test(SESSION));
	assert.ok(EID_PATTERN.test(createEid("ses")));
	assert.ok(!EID_PATTERN.test("01a11ae6-367a-7272-b582-6bda8b198f1d"));
	assert.ok(!EID_PATTERN.test("msg_1a11acf6af90azu1vpYxwTuwPD"));
	assert.ok(!EID_PATTERN.test("ses_1a11acf6af9"));
	assert.ok(!EID_PATTERN.test(""));
});

// --- fingerprint guard -------------------------------------------------------

test("guard rewrites pi's own identity into the CLI fingerprint", () => {
	const headers: Record<string, string> = {
		"x-opencode-session": "01a11ae6-367a-7272-b582-6bda8b198f1d",
		"x-opencode-client": "pi",
	};
	assert.equal(applyFingerprintGuard(headers, deps()), true);
	assert.equal(headers["x-opencode-client"], "cli");
	assert.equal(headers["x-opencode-session"], SESSION);
	assert.match(headers["x-opencode-request"], REQUEST_PATTERN);
	assert.equal(headers["x-opencode-project"], "pi-agent");
	assert.equal(headers["user-agent"], `opencode/${CLI_VERSION}`);
});

test("guard repairs a CLI-marked request whose session id is not an EID", () => {
	const headers: Record<string, string> = {
		"x-opencode-client": "cli",
		"x-opencode-session": "not-an-eid",
		"x-opencode-request": "not-an-eid",
	};
	assert.equal(applyFingerprintGuard(headers, deps()), true);
	assert.equal(headers["x-opencode-session"], SESSION);
	assert.match(headers["x-opencode-request"], REQUEST_PATTERN);
});

test("guard keeps a valid session and rotates only the request id", () => {
	const headers: Record<string, string> = {
		"x-opencode-session": SESSION,
		"x-opencode-client": "cli",
		"x-opencode-request": "msg_1a11acf6af90azu1vpYxwTuwPD",
		"x-opencode-project": "my session",
		"user-agent": `opencode/${CLI_VERSION}`,
	};
	assert.equal(applyFingerprintGuard(headers, deps()), true);
	assert.equal(headers["x-opencode-session"], SESSION);
	assert.notEqual(headers["x-opencode-request"], "msg_1a11acf6af90azu1vpYxwTuwPD");
	assert.match(headers["x-opencode-request"], REQUEST_PATTERN);
	assert.equal(headers["x-opencode-project"], "my session");
});

test("guard mints a session when pi sent none", () => {
	const headers: Record<string, string> = { "x-opencode-client": "pi" };
	assert.equal(applyFingerprintGuard(headers, deps()), true);
	assert.match(headers["x-opencode-session"], EID_PATTERN);
});

test("guard never touches a request that is not addressed to Zen", () => {
	const untouched: Record<string, string> = {
		"user-agent": "pi/1.1.0",
		authorization: "Bearer sk-live",
		"x-api-key": "anthropic",
	};
	assert.equal(applyFingerprintGuard(untouched, deps()), false);
	assert.deepEqual(untouched, {
		"user-agent": "pi/1.1.0",
		authorization: "Bearer sk-live",
		"x-api-key": "anthropic",
	});
});

test("guard is idempotent for the session it already installed", () => {
	const headers: Record<string, string> = { "x-opencode-client": "pi", "x-opencode-session": "uuid" };
	applyFingerprintGuard(headers, deps());
	const session = headers["x-opencode-session"];
	const request = headers["x-opencode-request"];
	applyFingerprintGuard(headers, deps());
	assert.equal(headers["x-opencode-session"], session);
	assert.notEqual(headers["x-opencode-request"], request);
});

// --- header value sanitisation ------------------------------------------------

test("sanitizeHeaderValue keeps printable ASCII untouched", () => {
	assert.equal(sanitizeHeaderValue("pi-agent"), "pi-agent");
	assert.equal(sanitizeHeaderValue("my session 42"), "my session 42");
	assert.equal(sanitizeHeaderValue("  padded  "), "padded");
});

test("sanitizeHeaderValue makes any name a valid header value", () => {
	for (const raw of ["mi sesión 🚀", "café", "日本語 name", "tab\tname", "line\nbreak", "\uD83D"]) {
		const value = sanitizeHeaderValue(raw);
		assert.match(value, /^[\x20-\x7E]*$/, `raw: ${JSON.stringify(raw)}`);
		assert.doesNotThrow(
			() =>
				new Request("https://opencode.ai/zen/v1/chat/completions", {
					headers: { "x-opencode-project": value },
				}),
			`raw: ${JSON.stringify(raw)}`,
		);
	}
});

test("sanitizeHeaderValue caps the encoded value", () => {
	assert.ok(sanitizeHeaderValue("x".repeat(1000)).length <= 200);
	assert.ok(sanitizeHeaderValue("🚀".repeat(200)).length <= 200);
});

test("guard writes an ASCII-safe project header for an emoji session name", () => {
	const headers: Record<string, string> = { "x-opencode-client": "pi", "x-opencode-session": "uuid" };
	assert.equal(applyFingerprintGuard(headers, deps(SESSION, "mi sesión 🚀")), true);
	for (const value of Object.values(headers)) assert.match(value, /^[\x20-\x7E]*$/);
	assert.doesNotThrow(
		() => new Request("https://opencode.ai/zen/v1/chat/completions", { headers }),
	);
});

// --- catalog mapping ---------------------------------------------------------

const CATALOG = {
	opencode: {
		models: {
			"free-chat": {
				id: "free-chat",
				name: "Free Chat",
				reasoning: true,
				cost: { input: 0, output: 0 },
				limit: { context: 131072, output: 8192 },
				modalities: { input: ["text", "image", "video"] },
			},
			"paid-chat": {
				id: "paid-chat",
				name: "Paid Chat",
				cost: { input: 1, output: 0 },
				limit: { context: 200000, output: 8192 },
			},
			"deprecated-free": {
				id: "deprecated-free",
				name: "Gone",
				status: "deprecated",
				cost: { input: 0, output: 0 },
				limit: { context: 200000, output: 8192 },
			},
		},
	},
};

test("toModelSeeds keeps only free, non-deprecated models", () => {
	const seeds = toModelSeeds(CATALOG);
	assert.deepEqual(seeds.map((m) => m.id), ["free-chat"]);
});

test("toModelSeeds normalizes modalities, limits and missing fields", () => {
	const [seed] = toModelSeeds(CATALOG);
	assert.deepEqual(seed.input, ["text", "image"]);
	assert.equal(seed.context, 131072);
	assert.equal(seed.output, 8192);
	assert.equal(seed.reasoning, true);
});

test("toModelSeeds survives an unusable catalog", () => {
	assert.deepEqual(toModelSeeds(undefined), []);
	assert.deepEqual(toModelSeeds({}), []);
	assert.deepEqual(toModelSeeds({ opencode: { models: {} } }), []);
});

test("toModelSeeds ignores entries without a usable id", () => {
	const seeds = toModelSeeds({ opencode: { models: { x: { cost: { input: 0, output: 0 } } } } });
	assert.deepEqual(seeds, []);
});
