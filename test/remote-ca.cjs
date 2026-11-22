const assert = require("node:assert/strict");
const https = require("node:https");
const tls = require("node:tls");
const { readFileSync } = require("node:fs");

// In a Remote Extension Host the desktop can supply a CA absent from Node.
// Model the host's request hook in this child only, then use real TLS on loopback.
const [url, caFile] = process.argv.slice(2);
const ca = readFileSync(caFile, "utf8");
assert.ok(!tls.getCACertificates("default").some(root => root.trim() === ca.trim()));
const nativeRequest = https.request;
let loads = 0;
https.request = (url, options, callback) => {
  assert.equal(options.rejectUnauthorized, true);
  if (!Object.hasOwn(options, "ca")) { options = { ...options, ca }; loads++; }
  return nativeRequest(url, options, response => {
    assert.equal(response.socket.authorized, true);
    callback(response);
  });
};

const { PandaClient } = require("../out/client");
const client = new PandaClient(() => ({}));
(async () => {
  try {
    const key = "pnd_it_proxy_fixture", signal = AbortSignal.timeout(5000);
    const models = await client.list(url, key, signal);
    assert.deepEqual(models.map(row => row.id), ["auto:cost"]);
    let answer = "";
    await client.chat(url, key, { model: "auto:cost", messages: ["host CA"] }, signal, part => { answer += part.text; });
    assert.equal(answer, "tunnel answer");
    assert.equal(loads, 2);
  } finally { await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
