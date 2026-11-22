const test = require("node:test");
const assert = require("node:assert/strict");
const { Access, secretSlot } = require("../out/access");
const { PandaClient } = require("../out/client");
const { GENERATE_ANOTHER, PandaReplay, responseError } = require("../out/errors");
const { GenerateActions } = require("../out/generate");
const { canonicalJSON, idempotencyKey } = require("../out/messages");
const { listen, frame, json, signal } = require("./fixture.cjs");

const token = "pnd_it_replay_fixture";
const cents = minor_units => ({ schema_version: "panda.usd-amount.v1", currency: "USD", minor_units });
const receipt = (status = "completed", amount = cents("3"), run_id = "run-public-42") => ({
  error: { code: "mixture_already_" + status, message: "upstream " + token },
  panda: { version: "panda.chat.v1", replay: true, run_id, status,
    request_id: "req_different_id", charge: amount, held: cents("9999") },
});

test("409 distinguishes paid, free, pending, unknown, conflicting and unsafe receipts", () => {
  for (const [status, amount, expected] of [
    ["completed", cents("3"), "USD 0.03"], ["partial", cents("12345"), "USD 123.45"],
    ["failed", cents("0"), "USD 0.00"], ["running", null, "has not settled"],
    ["failed", { ...cents("100"), currency: "EUR" }, "unavailable"], ["partial", cents("-4"), "unavailable"],
  ]) {
    const error = responseError(409, receipt(status, amount), token, "run-public-42");
    assert.ok(error instanceof PandaReplay); assert.ok(error.message.includes(GENERATE_ANOTHER));
    for (const item of [status, "run-public-42", expected]) assert.ok(error.message.includes(item));
    for (const item of ["req_different_id", "99.99", token, "upstream"]) assert.ok(!error.message.includes(item));
  }
  for (const id of ["a\nforged", token, "long".repeat(100)]) {
    const error = responseError(409, receipt("completed", cents("3"), id), token);
    assert.ok(!(error instanceof PandaReplay)); assert.ok(!error.message.includes(id)); assert.ok(!error.message.includes(GENERATE_ANOTHER));
  }
  const inconsistent = receipt(); inconsistent.panda.status = "running";
  for (const error of [responseError(409, inconsistent, token), responseError(409, receipt(), token, "run-other"),
    responseError(409, { error: { code: "mixture_already_completed" } }, token)]) assert.ok(!(error instanceof PandaReplay));
  const conflict = responseError(409, { ...receipt(), error: { code: "mixture_idempotency_conflict" } }, token);
  assert.match(conflict.message, /different request body/); assert.ok(!conflict.message.includes(GENERATE_ANOTHER));
});

test("the paid action binds exact request, endpoint and current token, and recovers its child key across clients", async t => {
  const rows = [], ledger = new Map();
  const api = await listen(async (req, res) => {
    rows.push(req.method);
    if (req.method === "GET") return json(res, { data: [{ id: "auto" }] });
    const key = req.headers["idempotency-key"];
    if (ledger.has(key)) return json(res, receipt("completed", cents("3"), ledger.get(key)), 409);
    const id = "run-" + (ledger.size + 1); ledger.set(key, id);
    res.writeHead(200, { "content-type": "text/event-stream" }).end(frame({ content: id }, "stop"));
  });
  const another = await listen((req, res) => { rows.push("OTHER"); res.writeHead(500).end(); });
  const clients = [new PandaClient(), new PandaClient()];
  t.after(async () => { for (const client of clients) await client.close(); await api.close(); await another.close(); });
  let endpoint = api.endpoint;
  const slots = new Map([[secretSlot(endpoint), token], [secretSlot(another.endpoint), token]]);
  const access = clients.map(client => new Access({ get: async slot => slots.get(slot) }, () => endpoint, client));
  const body = { model: "auto", stream: true, messages: [{ role: "user", content: "Keep the same message" }] };
  const wire = canonicalJSON(body);
  const invoke = (gate, operation, onReplay, data = body) => gate.chat("auto", data, signal(), () => {}, onReplay, operation);
  await invoke(access[0]);
  let paid; const save = (_err, actualWire, operation) => { assert.equal(actualWire, wire); paid = operation; };
  await assert.rejects(invoke(access[0], undefined, save), PandaReplay);
  assert.equal(paid.afterRun, "run-1");
  assert.equal(paid.originalKey, idempotencyKey(endpoint, token, wire));
  const before = rows.length;
  slots.set(secretSlot(endpoint), "pnd_it_rotated");
  await assert.rejects(invoke(access[0], paid), /changed/);
  slots.set(secretSlot(endpoint), token); endpoint = another.endpoint;
  await assert.rejects(invoke(access[0], paid), /changed/);
  endpoint = api.endpoint;
  await assert.rejects(invoke(access[0], paid, undefined, { ...body, messages: [] }), /changed/);
  assert.equal(rows.length, before);
  await invoke(access[0], paid);
  await assert.rejects(invoke(access[1]), /run-1/);
  await assert.rejects(invoke(access[1], paid), /run-2/);
  assert.deepEqual([...ledger.keys()], [paid.originalKey, idempotencyKey(endpoint, token, wire, "run-1")]);
  assert.equal(ledger.size, 2);
});

test("dismissed or expired offers cannot start a paid request, and earlier answer tabs remain available", async () => {
  const offers = [], notes = [], opened = [];
  let posts = 0;
  const actions = new GenerateActions({ async chat(_model, _wire, signal) {
    posts++;
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
  } }, { ViewColumn: { Beside: 2 }, window: {
    showWarningMessage: () => new Promise(resolve => offers.push(resolve)),
    showInformationMessage: value => notes.push(value),
    createWebviewPanel() {
      let close;
      const panel = { webview: {}, onDidDispose: fn => { close = fn; }, dispose: () => close() };
      opened.push(panel); return panel;
    },
  } });
  const offer = i => actions.offer("auto", new PandaReplay("run-" + i, "Receipt"), "{}",
    { originalKey: "key-" + i, afterRun: "run-" + i });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 5; i++) offer(i);
  offers.shift()(GENERATE_ANOTHER); await tick(); assert.equal(posts, 0);
  offers.shift()(undefined); await tick(); assert.equal(posts, 0);
  actions.clear();
  for (const pick of offers.splice(0)) pick(GENERATE_ANOTHER);
  await tick(); assert.equal(posts, 0);
  for (let i = 0; i < 5; i++) { offer(i); offers.shift()(GENERATE_ANOTHER); await tick(); }
  assert.equal(posts, 5); assert.equal(opened.length, 5); assert.ok(notes.some(note => note.includes("expired")));
  actions.dispose();
});
