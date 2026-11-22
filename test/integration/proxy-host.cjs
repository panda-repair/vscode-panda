const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const vscode = require("vscode");

async function ask(model, text) {
  const cancel = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => cancel.cancel(), 6000);
  try {
    const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(text)], {}, cancel.token);
    let result = ""; for await (const text of response.text) result += text; return result;
  } finally { clearTimeout(timer); cancel.dispose(); }
}

async function expectAnswer(model, text) {
  await assert.doesNotReject(async () => assert.equal(await ask(model, text), "tunnel answer"), text);
}

const http = () => vscode.workspace.getConfiguration("http");
const set = (name, value) => http().update(name, value, vscode.ConfigurationTarget.Global);

async function setEndpoint(secrets, endpoint) {
  await vscode.workspace.getConfiguration("panda").update("baseUrl", endpoint, vscode.ConfigurationTarget.Global);
  const slot = "panda.apiKey." + createHash("sha256").update(endpoint).digest("hex");
  await secrets.store(slot, "pnd_it_proxy_fixture");
}

async function selectAt(secrets, select, endpoint) {
  await setEndpoint(secrets, endpoint);
  return (await select(["auto:cost"], "Catalog at " + endpoint))[0];
}

exports.verifyPac407 = async function verifyPac407(secrets, select) {
  const { endpoint, requiredAuth } = JSON.parse(process.env.PANDA_PROXY_FIXTURE);
  assert.equal(http().inspect("proxy").globalValue, undefined);
  assert.equal(http().get("proxySupport"), "override");
  assert.equal(http().get("proxyAuthorization"), requiredAuth);
  const model = await selectAt(secrets, select, endpoint);
  await set("proxyAuthorization", "Bearer wrong-fixture-407");
  await assert.rejects(ask(model, "PAC rejects the proxy credential"), {
    message: "The network proxy requires authentication. Check the proxy address and credentials.",
  });
};

exports.verifyFixedProxy = async function verifyFixedProxy(secrets, select) {
  const fixture = JSON.parse(process.env.PANDA_PROXY_FIXTURE);
  await set("proxySupport", "override");
  await set("proxy", fixture.httpProxy);
  const model = await selectAt(secrets, select, fixture.endpoint);
  await expectAnswer(model, "fixed proxy");
  await set("proxy", fixture.httpsProxy); await set("proxyStrictSSL", true);
  await assert.rejects(ask(model, "strict untrusted HTTPS proxy"), /connection/);
  await set("proxyStrictSSL", false);
  await expectAnswer(model, "HTTPS proxy only");
  await set("proxy", undefined); await set("proxyStrictSSL", true);
  process.env.HTTPS_PROXY = fixture.httpProxy;
  await expectAnswer(model, "environment proxy");
  delete process.env.HTTPS_PROXY;
};

exports.verifyPac = async function verifyPac(secrets, select, provider) {
  const fixture = JSON.parse(process.env.PANDA_PROXY_FIXTURE);
  assert.equal(http().inspect("proxy").globalValue, undefined);
  assert.equal(http().get("proxySupport"), "override");
  assert.equal(http().get("proxyAuthorization"), fixture.requiredAuth);
  const model = await selectAt(secrets, select, fixture.endpoint);
  await expectAnswer(model, "HTTPS PAC proxy");
  await set("proxyStrictSSL", true);
  await assert.rejects(ask(model, "PAC rejects the untrusted proxy CA"), /connection/);
  const office = await selectAt(secrets, select, fixture.office);
  await expectAnswer(office, "HTTP PAC proxy");
  await set("proxyStrictSSL", false);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "1");
  await setEndpoint(secrets, fixture.untrusted);
  const cancel = new vscode.CancellationTokenSource();
  try {
    await assert.rejects(provider.provideLanguageModelChatInformation({ silent: true }, cancel.token), /connection/);
  } finally { cancel.dispose(); }
  // Only the test origin's DNS address is supplied here. VS Code still chooses its PAC route.
  const dns = require("node:dns");
  const lookup = dns.lookup;
  let directLookups = 0;
  dns.lookup = function (host, options, callback) {
    if (host === "panda-direct.invalid") {
      directLookups++;
      const family = typeof options === "object" ? options?.family : options;
      host = family === 6 || family === "IPv6" ? "::ffff:127.0.0.1" : "127.0.0.1";
    }
    return lookup.call(this, host, options, callback);
  };
  try {
    const direct = await selectAt(secrets, select, fixture.direct);
    await expectAnswer(direct, "PAC DIRECT");
    assert.ok(directLookups > 0);
  } finally { dns.lookup = lookup; }
  const offHostStatus = await new Promise((resolve, reject) => {
    // A mistaken DIRECT route must fail locally before DNS or an origin connection.
    const req = require("https").get("https://panda-unmatched.invalid/", {
      signal: AbortSignal.timeout(5000), lookup: (_host, _options, callback) => callback(new Error("Unexpected direct lookup")),
    }, response => { response.resume(); resolve(response.statusCode); });
    req.on("error", reject);
  });
  assert.equal(offHostStatus, 403);
  process.env.HTTPS_PROXY = fixture.httpProxy; process.env.NO_PROXY = new URL(fixture.bypass).hostname;
  const bypass = await selectAt(secrets, select, fixture.bypass);
  await expectAnswer(bypass, "bypass proxy");
};
