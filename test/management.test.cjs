const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { join } = require("node:path");
const { secretSlot } = require("../out/access");
const { listen, json } = require("./fixture.cjs");

const disposable = { dispose() {} };
class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; };
  }
  fire(data) { for (const fn of this.listeners) fn(data); }
  dispose() { this.listeners.clear(); }
}

test("silent list, interactive password setup, check, cancel, change and clear use only the scoped SecretStorage slot", async t => {
  const keys = new Map([["pnd_it_a", ["auto:cost"]], ["pnd_it_b", ["panel:panda"]]]);
  const requests = [], inputs = [], actions = [], notifications = [], errors = [], passwordBoxes = [];
  const api = await listen((req, res) => {
    const key = req.headers.authorization.replace("Bearer ", "");
    requests.push(key);
    if (!keys.has(key)) return json(res, { error: { message: key } }, 401);
    json(res, { data: keys.get(key).map(id => ({ id })) });
  });
  t.after(() => api.close());
  const events = new EventEmitter(), stored = new Map(), commands = new Map(), providers = new Map();
  const host = { EventEmitter, CancellationError: class extends Error {},
    LanguageModelError: { NoPermissions: text => new Error(text), NotFound: text => new Error(text), Blocked: text => new Error(text) },
    commands: { registerCommand(id, fn) { commands.set(id, fn); return disposable; } },
    workspace: { getConfiguration: () => ({ inspect: () => ({ globalValue: api.endpoint, workspaceValue: "http://127.0.0.1:1/v1" }) }),
      onDidChangeConfiguration: () => disposable },
    window: { showInputBox: async options => { passwordBoxes.push(options); return inputs.shift(); },
      showQuickPick: async () => actions.shift(), showInformationMessage: text => notifications.push(text),
      showErrorMessage: text => errors.push(text) },
    lm: { registerLanguageModelChatProvider(id, provider) { providers.set(id, provider); return disposable; } } };
  const source = join(__dirname, "..", "out", "extension.js"), product = new Module(source, module);
  const load = product.require.bind(product);
  product.filename = source; product.paths = module.paths;
  product.require = id => id === "vscode" ? host : load(id);
  product.load(source);
  const context = { subscriptions: [], secrets: { onDidChange: events.event, get: async key => stored.get(key),
    async store(key, value) { stored.set(key, value); events.fire({ key }); },
    async delete(key) { stored.delete(key); events.fire({ key }); } } };
  product.exports.activate(context);
  t.after(() => { for (const item of context.subscriptions) item.dispose(); });
  const provider = providers.get("panda"), manage = commands.get("panda.manageApiKey");
  const token = { isCancellationRequested: false, onCancellationRequested: () => disposable };
  const list = async silent => (await provider.provideLanguageModelChatInformation({ silent }, token)).map(m => m.id);
  assert.deepEqual(await list(true), []); assert.deepEqual(passwordBoxes, []); assert.deepEqual(requests, []);
  assert.deepEqual(await list(false), []); assert.equal(passwordBoxes.length, 1); assert.deepEqual(requests, []);
  inputs.push("pnd_it_a");
  assert.deepEqual(await list(false), ["auto:cost"]);
  assert.equal(passwordBoxes[1].password, true); assert.match(passwordBoxes[1].prompt, /127\.0\.0\.1/);
  assert.ok(passwordBoxes[1].validateInput("wrong")); assert.equal(passwordBoxes[1].validateInput("pnd_it_a"), undefined);
  assert.deepEqual([...stored.keys()], [secretSlot(api.endpoint)]);
  assert.deepEqual(requests, ["pnd_it_a"]);
  actions.push("Check current key"); await manage();
  assert.equal(requests.length, 2); assert.match(notifications.at(-1), /verified/);
  await manage(); assert.equal(requests.length, 2);
  actions.push("Change API key"); await manage(); assert.equal(requests.length, 2);
  actions.push("Change API key"); inputs.push("pnd_it_invalid"); await manage();
  assert.equal(stored.get(secretSlot(api.endpoint)), "pnd_it_a"); assert.match(errors.at(-1), /wrong or expired/);
  assert.ok(!errors.join().includes("pnd_it_"));
  actions.push("Change API key"); inputs.push("pnd_it_b"); await manage();
  assert.deepEqual(await list(true), ["panel:panda"]);
  actions.push("Clear API key"); await manage();
  assert.deepEqual(await list(true), []); assert.equal(stored.size, 0); assert.equal(passwordBoxes.length, 5);
});
