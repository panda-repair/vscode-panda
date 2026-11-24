const test = require("node:test");
const assert = require("node:assert/strict");
const { chatBody, mapMessages, idempotencyKey, canonicalJSON, tokenEstimate } = require("../out/messages");
const { models, grantedModels } = require("../out/catalog");
const { normalizeEndpoint, secretSlot } = require("../out/access");
const { Text, Data, ToolCall, ToolResult, host } = require("./fixture.cjs");

test("all five models have the stated input, output and stable capabilities; discovery intersects direct grants", () => {
  assert.deepEqual(models.map(m => [m.id, m.name, m.maxInputTokens]), [
    ["auto", "Panda Auto", 207616], ["auto:cost", "Panda Mini", 241616],
    ["auto:quality", "Panda Max", 170616], ["panel:panda", "Panda Mix", 207616],
    ["panel:panda-quality", "Panda Mix Pro", 207616],
  ]);
  for (const model of models) {
    assert.equal(model.maxOutputTokens, 16384);
    assert.deepEqual(model.capabilities, { imageInput: false, toolCalling: true });
    assert.ok(!("isDefault" in model));
  }
  assert.deepEqual(grantedModels([{ id: "foreign" }, { id: "auto:cost" }, { id: "auto:cost" }]).map(m => m.id), ["auto:cost"]);
  assert.deepEqual(grantedModels([]), []);
  assert.throws(() => grantedModels([{ name: "auto" }]), /invalid model catalog/);
});

test("credential slots use normalized endpoints and reject unsafe URLs", () => {
  assert.equal(normalizeEndpoint("https://EXAMPLE.test:443/a/../v1/"), "https://example.test/v1");
  assert.equal(secretSlot("https://EXAMPLE.test/v1///"), secretSlot("https://example.test/v1"));
  assert.notEqual(secretSlot("https://example.test/v1"), secretSlot("https://example.test/staging/v1"));
  assert.equal(normalizeEndpoint("http://[::1]:123/v1"), "http://[::1]:123/v1");
  for (const url of ["ftp://a.test", "http://a.test", "https://example.test/v1?", "https://example.test/v1#",
    "https://name:secret@example.test/v1", "not a url"]) assert.throws(() => normalizeEndpoint(url));
});

test("messages keep assistant text and parallel tool calls, and preserve user/tool-result ordering", () => {
  const messages = [{ role: 1, name: "user", content: [new Text("h"), new Text("i")] },
    { role: 2, content: [new Text("Working"), new ToolCall("one", "read", { path: "a" }), new ToolCall("two", "list", {})] },
    { role: 1, content: [new ToolResult("one", [new Text("fi"), new Text("le")]), new Text("Another"),
      new ToolResult("two", [new Text("list")]), new Text("Next")] }];
  assert.deepEqual(mapMessages(messages, host), [
    { role: "user", name: "user", content: "hi" },
    { role: "assistant", content: "Working", tool_calls: [
      { id: "one", type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
      { id: "two", type: "function", function: { name: "list", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "one", content: "file" }, { role: "tool", tool_call_id: "two", content: "list" },
    { role: "user", content: "Another" }, { role: "user", content: "Next" },
  ]);
  assert.throws(() => mapMessages([{ role: 1, content: [{}] }], host), /unsupported/);
  assert.throws(() => mapMessages([{ role: 1, content: [new ToolResult("x", [{}])] }], host), /unsupported/);
});

test("Copilot's ephemeral marker disappears without losing genuine empty messages or UTF-8 tool results", () => {
  const marker = new Data(Buffer.from("ephemeral"), "cache_control");
  const data = (value, mime) => new Data(Buffer.from(value), mime);
  const messages = [{ role: 1, content: [marker] }, { role: 1, content: [] },
    { role: 3, content: [data("Guide", "text/markdown"), marker] },
    { role: 1, content: [data("🐼", "text/plain; charset=utf-8"), marker] },
    { role: 2, content: [new ToolCall("a", "read", {}), new ToolCall("b", "read", {})] },
    { role: 1, content: [new ToolResult("b", [marker])] }, { role: 1, name: "me", content: [new Text("Note")] },
    { role: 1, content: [new ToolResult("a", [marker, data("**yes**", "text/markdown")])] }];
  const out = mapMessages(messages, host);
  assert.deepEqual(out.map(m => [m.role, m.content]), [["user", ""], ["system", "Guide"], ["user", "🐼"],
    ["assistant", null], ["tool", ""], ["tool", "**yes**"], ["user", "Note"]]);
  assert.equal(out.at(-1).name, "me");
  assert.deepEqual(out.slice(4, 6).map(m => m.tool_call_id), ["b", "a"]);
  assert.equal(tokenEstimate(messages[0], host), 0);
  assert.equal(tokenEstimate(messages[3], host), 1);
  for (const part of [data("other", "cache_control"), data("ephemeral", "application/cache_control"),
    data("hi", "image/png"), data("hi", "text/plain; charset=utf-16")]) {
    assert.throws(() => mapMessages([{ role: 1, content: [part] }], host), /unsupported content/);
  }
  assert.throws(() => tokenEstimate({ role: 1, content: [new Data(Uint8Array.of(255), "text/plain")] }, host), /UTF-8/);
});

test("host-supplied agent instructions keep their System role and unrecognized roles fail locally", () => {
  const instructions = [{ role: 3, content: [new Text("Use "), new Text("the tool.")] }];
  assert.deepEqual(mapMessages(instructions, host), [{ role: "system", content: "Use the tool." }]);
  assert.throws(() => mapMessages([{ role: 4, content: [new Text("Hello")] }], host), /unsupported chat role/);
  assert.throws(() => mapMessages([{ role: 3, content: [new ToolCall("x", "read", {})] }], host), /unsupported/);
});

test("map tools, tool mode and output limits without letting model options change credentials or target", () => {
  const schema = { type: "object", properties: { path: { $ref: "#/$defs/path" } }, $defs: { path: { type: "string" } } };
  for (const [mode, choice] of [[1, "auto"], [2, "required"]]) {
    const body = chatBody("auto:cost", [], { tools: [{ name: "read", description: "Read", inputSchema: schema }], toolMode: mode,
      modelOptions: { max_tokens: 999999, maxOutputTokens: 40, model: "other", headers: { X: "fake" } } }, host);
    assert.deepEqual(body, { model: "auto:cost", stream: true, messages: [], max_tokens: 40, tool_choice: choice,
      tools: [{ type: "function", function: { name: "read", description: "Read", parameters: schema } }] });
  }
  const bare = chatBody("auto", [], { toolMode: 1, modelOptions: { max_completion_tokens: 99999 } }, host);
  assert.equal(bare.max_tokens, 16384);
  assert.ok(!("tool_choice" in bare));
  for (const n of [0, -1, 1.5, "3"]) assert.throws(() => chatBody("auto", [], { modelOptions: { max_tokens: n } }, host));
  assert.throws(() => chatBody("auto", [], { toolMode: 2 }, host), /required tool/);
});

test("idempotency is stable across caller retries but separates endpoint, key and meaningful wire changes", () => {
  const first = { messages: [{ content: "text", role: "user" }], model: "auto", max_tokens: 40 };
  const reordered = { max_tokens: 40, model: "auto", messages: [{ role: "user", content: "text" }] };
  const key = (body, endpoint = "https://example.test/v1", token = "pnd_it_fixture") =>
    idempotencyKey(endpoint, token, canonicalJSON(body));
  assert.match(key(first), /^panda-vscode-[0-9a-f]{64}$/);
  assert.equal(key(first), key(reordered));
  for (const delta of [{ model: "panel:panda" }, { messages: [{ role: "user", content: "changed" }] },
    { max_tokens: 42 }, { tools: [{ type: "function" }] }, { tool_choice: "required" }]) {
    assert.notEqual(key(first), key({ ...first, ...delta }));
  }
  assert.notEqual(key(first), key(first, "https://staging.test/v1"));
  assert.notEqual(key(first), key(first, undefined, "pnd_it_other"));
});

test("token estimates round Unicode characters and include structured tools", () => {
  assert.equal(tokenEstimate("", host), 0);
  assert.equal(tokenEstimate("🐼🐼🐼🐼", host), 1);
  assert.equal(tokenEstimate({ role: 1, content: [new Text("abc"), new Text("de")] }, host), 2);
  assert.ok(tokenEstimate({ role: 2, content: [new ToolCall("call", "read", { path: "/fixture" })] }, host) > 3);
});
