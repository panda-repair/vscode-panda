const test = require("node:test");
const assert = require("node:assert/strict");
const { subscribe, unsubscribe } = require("node:diagnostics_channel");
const { PandaClient, IDLE_TIMEOUT_MS } = require("../out/client");
const { models } = require("../out/catalog");
const { listen, json, frame, pause, signal } = require("./fixture.cjs");

const key = "pnd_it_transport_fixture";
const body = model => ({ model, stream: true, max_tokens: 16384, messages: [{ role: "user", content: "Read" }] });
const method = "undici:request:create";
async function fixture(t, handle) {
  const server = await listen(handle);
  const client = new PandaClient();
  t.after(async () => { await client.close(); await server.close(); });
  return { client, ...server };
}

test("stream split UTF-8 text before the finish, then assemble interleaved tools once in index order", async t => {
  const seenText = Promise.withResolvers();
  const { client, endpoint } = await fixture(t, async (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    const first = Buffer.from(": keepalive\r\n" + frame({ content: "🐼" }).replaceAll("\n", "\r\n"));
    const cut = first.indexOf(Buffer.from("🐼")) + 1;
    res.write(first.subarray(0, cut)); await pause(5);
    res.write(first.subarray(cut)); await seenText.promise;
    res.write(frame({ tool_calls: [{ index: 1, id: "c", function: { name: "li", arguments: "{" } },
      { index: 0, id: "c", function: { name: "re", arguments: '{"n":' } }] }));
    res.end(frame({ tool_calls: [{ index: 0, id: "1", function: { name: "ad", arguments: "1}" } },
      { index: 1, id: "2", function: { name: "st", arguments: "}" } }] }, "tool_calls") + "data: [DONE]\n\n");
  });
  const output = [];
  await client.chat(endpoint, key, body("auto"), AbortSignal.timeout(2000), part => {
    output.push(part); if ("text" in part) seenText.resolve();
  });
  assert.deepEqual(output, [{ text: "🐼" }, { id: "c1", name: "read", input: { n: 1 } }, { id: "c2", name: "list", input: {} }]);
});

test("every selector waits for delayed headers and body, with ten minute limits and a stable single wire key", async t => {
  const requests = [], observed = [];
  const { client, endpoint } = await fixture(t, async (req, res) => {
    let payload = ""; for await (const chunk of req) payload += chunk;
    requests.push({ path: req.url, auth: req.headers.authorization, raw: req.rawHeaders,
      key: req.headers["idempotency-key"], body: JSON.parse(payload) });
    await pause(20); res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
    await pause(20); res.end(frame({ content: "ok" }, "stop"));
  });
  function inspect({ request }) {
    if (String(request.origin) === new URL(endpoint).origin)
      observed.push([request.headersTimeout, request.bodyTimeout]);
  }
  subscribe(method, inspect); t.after(() => unsubscribe(method, inspect));
  for (const m of [...models, models[0]]) {
    const parts = []; await client.chat(endpoint, key, body(m.id), signal(), part => parts.push(part));
    assert.deepEqual(parts, [{ text: "ok" }]);
  }
  assert.equal(IDLE_TIMEOUT_MS, 600000);
  assert.deepEqual(observed, requests.map(() => [600000, 600000]));
  assert.equal(requests.length, 6);
  assert.equal(new Set(requests.map(r => r.key)).size, 5);
  assert.equal(requests[0].key, requests.at(-1).key);
  for (const r of requests) {
    assert.equal(r.path, "/v1/chat/completions"); assert.equal(r.auth, "Bearer " + key);
    assert.equal(r.raw.filter(h => h.toLowerCase() === "idempotency-key").length, 1);
    assert.match(r.key, /^panda-vscode-[a-f0-9]{64}$/);
  }
});

test("HTTP errors keep bounded credential-free context and never replay or follow redirects", async t => {
  let received = 0, redirects = 0;
  const sink = await listen((_req, res) => { redirects++; res.end(); });
  t.after(() => sink.close());
  let status;
  const { client, endpoint } = await fixture(t, (_req, res) => {
    received++;
    if ([307, 308].includes(status)) res.setHeader("location", sink.endpoint);
    json(res, { error: { code: "context_length_exceeded", message: "fixture limit " + key + " " + "x".repeat(1000) } }, status);
  });
  const checks = [[400, /context limit/], [401, /wrong or expired/], [403, /does not permit/], [402, /fixture limit/],
    [429, /fixture limit/], [409, /replay/], [421, /HTTP 421/], [500, /may already have run/],
    [307, /redirect/], [308, /redirect/]];
  for (const [code, message] of checks) {
    status = code;
    await assert.rejects(client.chat(endpoint, key, body("auto"), signal(), assert.fail), error => {
      assert.match(error.message, message); assert.ok(!error.message.includes(key)); assert.ok(error.message.length < 400);
      return true;
    });
  }
  status = 307; await assert.rejects(client.list(endpoint, key, signal()), /redirect/);
  await pause(10);
  assert.equal(received, checks.length + 1); assert.equal(redirects, 0);
});

test("all four SSE error envelopes take precedence over successful-looking text and tool calls", async t => {
  let message;
  const { client, endpoint } = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.end(message);
  });
  const error = { message: "quota " + key, code: "throttle_workspace_rate_limited" };
  const delta = { content: "must not escape", tool_calls: [{ index: 0, id: "x", function: { name: "x", arguments: "{}" } }] };
  for (const [tag, data] of [["message", { error, choices: [{ delta, finish_reason: "stop" }] }],
    ["message", { choices: [{ error, delta, finish_reason: "stop" }] }],
    ["message", { choices: [{ delta: { ...delta, error }, finish_reason: "stop" }] }],
    ["error", { status: 429, message: error.message }]]) {
    message = "event: " + tag + "\r\ndata: " + JSON.stringify(data) + "\r\n\r\n";
    const parts = [];
    await assert.rejects(client.chat(endpoint, key, body("auto"), signal(), part => parts.push(part)), e => {
      assert.equal(e.kind, "blocked"); assert.match(e.message, /quota/); assert.ok(!e.message.includes(key)); return true;
    });
    assert.deepEqual(parts, []);
  }
});

test("invalid events, wrong content type, incomplete tool JSON and unconfirmed ends never execute tools", async t => {
  let raw, type;
  const { client, endpoint } = await fixture(t, (_req, res) => { res.writeHead(200, { "content-type": type }); res.end(raw); });
  for (const [format, contents, message] of [
    ["application/json", '{"oops":true}', /format/], ["text/event-stream", "data: invalid\n\n", /invalid stream/],
    ["text/event-stream", "data: [DONE]\n\n", /may have run/],
    ["text/event-stream", frame({ tool_calls: [{ index: 0, id: "x", function: { name: "tool", arguments: "{" } }] }), /may have run/],
    ["text/event-stream", frame({ tool_calls: [{ index: 0, id: "x", function: { name: "tool", arguments: "{" } }] }, "tool_calls"), /arguments/],
    ["text/event-stream", frame({ tool_calls: [0, 1].map(index => ({ index, id: "x",
      function: { name: "tool", arguments: "{}" } })) }, "tool_calls"), /invalid tool call/],
    ["text/event-stream", frame({}, "content_filter"), /declined/], ["text/event-stream", frame({}, "length"), /output token limit/],
  ]) {
    raw = contents; type = format;
    const parts = [];
    await assert.rejects(client.chat(endpoint, key, body("auto"), signal(), p => parts.push(p)), message);
    assert.deepEqual(parts, []);
  }
  await pause(10);
});

test("a length finish preserves delivered answer text and releases no incomplete tool call", async t => {
  const { client, endpoint } = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame({ content: "The first " }));
    res.end(frame({ content: "half", tool_calls: [{ index: 0, id: "pending", function: {
      name: "unavailable", arguments: '{"file":' } }] }, "length"));
  });
  const parts = [];
  await assert.rejects(client.chat(endpoint, key, body("auto"), signal(), part => parts.push(part)),
    require("../out/errors").PandaOutputLimit);
  assert.deepEqual(parts, [{ text: "The first " }, { text: "half" }]);
});

test("cancellation before submission or during header/body waits closes the request and never retries", async t => {
  const connected = [Promise.withResolvers(), Promise.withResolvers()];
  const closed = [Promise.withResolvers(), Promise.withResolvers()];
  let attempts = 0;
  const { client, endpoint } = await fixture(t, (_req, res) => {
    const i = attempts++;
    res.once("close", () => closed[i]?.resolve());
    if (i === 1) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": keepalive\n\n"); }
    connected[i]?.resolve();
  });
  const already = AbortSignal.abort(new Error("fixture cancelled"));
  await assert.rejects(client.chat(endpoint, key, body("auto"), already, assert.fail), /fixture cancelled/);
  for (let i = 0; i < 2; i++) {
    const controller = new AbortController();
    const pending = client.chat(endpoint, key, body("auto"), controller.signal, assert.fail);
    await connected[i].promise; controller.abort(new Error("fixture cancelled"));
    await assert.rejects(pending, /fixture cancelled/); await closed[i].promise;
  }
  assert.equal(attempts, 2);
});

test("a dropped submitted request reports an uncertain charge and is not retried", async t => {
  let count = 0;
  const { client, endpoint } = await fixture(t, req => { count++; req.socket.destroy(); });
  await assert.rejects(client.chat(endpoint, key, body("auto"), signal(), assert.fail), /may have run and been charged/);
  assert.equal(count, 1);
});
