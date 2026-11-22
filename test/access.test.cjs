const test = require("node:test");
const assert = require("node:assert/strict");
const { Access, secretSlot } = require("../out/access");
const { PandaClient } = require("../out/client");
const { listen, json, frame, signal } = require("./fixture.cjs");

function storage() {
  const map = new Map();
  return { get: async k => map.get(k), store: async (k, v) => { map.set(k, v); },
    delete: async k => { map.delete(k); } };
}
const ids = rows => rows.map(r => r.id);

test("only the current key's listed selectors can be sent, including after login, narrowing, failure and logout", async t => {
  const grants = new Map([["Bearer pnd_it_A", ["auto:cost", "unknown"]], ["Bearer pnd_it_B", ["panel:panda"]]]);
  const traffic = [];
  const api = await listen((req, res) => {
    const allowed = grants.get(req.headers.authorization);
    traffic.push([req.method, req.url, req.headers.authorization]);
    if (!allowed) return json(res, {}, 401);
    if (req.method === "GET") return json(res, { data: allowed.map(id => ({ id })) });
    res.writeHead(200, { "content-type": "text/event-stream" }).end(frame({ content: "ok" }, "stop"));
  });
  const client = new PandaClient();
  t.after(async () => { await client.close(); await api.close(); });
  const secrets = storage(), gate = new Access(secrets, () => api.endpoint, client);
  const list = async () => ids(await gate.list(await gate.identity(signal()), signal()));
  assert.deepEqual(await list(), []); assert.equal(traffic.length, 0);
  await gate.set(await gate.identity(signal()), "pnd_it_A", signal());
  assert.deepEqual(await list(), ["auto:cost"]); assert.equal(traffic.length, 1);
  await assert.rejects(gate.chat("unknown", {}, signal(), assert.fail), /unavailable/);
  assert.equal(traffic.length, 1);
  await gate.chat("auto:cost", { model: "auto:cost" }, signal(), () => {});
  grants.set("Bearer pnd_it_A", ["auto:quality"]);
  await assert.rejects(gate.chat("auto:cost", { model: "auto:cost" }, signal(), assert.fail), /no grant/);
  assert.deepEqual(await list(), ["auto:quality"]); assert.equal(traffic.filter(t => t[0] === "POST").length, 1);
  await assert.rejects(gate.set(await gate.identity(signal()), "pnd_it_invalid", signal()), /wrong or expired/);
  assert.equal(await secrets.get(secretSlot(api.endpoint)), "pnd_it_A");
  await gate.set(await gate.identity(signal()), "pnd_it_B", signal());
  assert.deepEqual(await list(), ["panel:panda"]);
  await gate.clear(await gate.identity(signal()), signal());
  assert.deepEqual(await list(), []);
  await assert.rejects(gate.chat("panel:panda", {}, signal(), assert.fail), /Set your Panda API key/);
  assert.equal(traffic.filter(t => t[0] === "POST").length, 1);
});

test("an endpoint switch cannot forward an old key, including a change during token entry", async t => {
  const seen = [[], []], servers = [];
  for (const events of seen) servers.push(await listen((req, res) => {
    events.push(req.headers.authorization); json(res, { data: [{ id: "auto" }] });
  }));
  const client = new PandaClient();
  t.after(async () => { await client.close(); for (const server of servers) await server.close(); });
  let endpoint = servers[0].endpoint;
  const secrets = storage(), access = new Access(secrets, () => endpoint, client);
  await access.set(await access.identity(signal()), "pnd_it_first", signal());
  const stale = await access.identity(signal());
  endpoint = servers[1].endpoint;
  await assert.rejects(access.set(stale, "pnd_it_never_sent", signal()), /changed/);
  assert.deepEqual(await access.list(await access.identity(signal()), signal()), []);
  await assert.rejects(access.chat("auto", {}, signal(), assert.fail), /Set your Panda API key/);
  await access.set(await access.identity(signal()), "pnd_it_second", signal());
  assert.deepEqual(seen, [["Bearer pnd_it_first"], ["Bearer pnd_it_second"]]);
  assert.equal(await secrets.get(secretSlot(servers[0].endpoint)), "pnd_it_first");
});

test("key rotation during a catalog request cannot authorize a stale POST or replace new grants", async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const seen = [];
  const api = await listen(async (req, res) => {
    seen.push([req.method, req.headers.authorization]);
    if (req.headers.authorization === "Bearer pnd_it_old") {
      started.resolve(); await release.promise; json(res, { data: [{ id: "auto" }] });
    } else json(res, { data: [{ id: "auto:cost" }] });
  });
  const client = new PandaClient(); t.after(async () => { release.resolve(); await client.close(); await api.close(); });
  const secrets = storage(), access = new Access(secrets, () => api.endpoint, client);
  await secrets.store(secretSlot(api.endpoint), "pnd_it_old");
  const paid = access.chat("auto", { model: "auto" }, signal(), assert.fail);
  await started.promise;
  // Even when a host notification lags, the final SecretStorage check sees the rotation.
  await secrets.store(secretSlot(api.endpoint), "pnd_it_new");
  assert.deepEqual(ids(await access.list(await access.identity(signal()), signal(), true)), ["auto:cost"]);
  release.resolve();
  await assert.rejects(paid, /changed/);
  assert.deepEqual(ids(await access.list(await access.identity(signal()), signal())), ["auto:cost"]);
  assert.ok(seen.every(([method]) => method === "GET"));
});
