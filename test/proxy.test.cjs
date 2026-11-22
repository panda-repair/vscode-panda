const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { proxyFixture } = require("./proxy-fixture.cjs");
const { proxyRoute } = require("../out/transport");
const run = promisify(execFile);

test("native discovery and chat accept a CA supplied only by the extension host", async t => {
  const dir = mkdtempSync(join(tmpdir(), "panda-remote-ca-"));
  const fixture = await proxyFixture(dir);
  t.after(async () => { await fixture.close(); rmSync(dir, { recursive: true, force: true }); });
  await run(process.execPath, [join(__dirname, "remote-ca.cjs"), fixture.bypass, fixture.ca], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: "", NODE_TLS_REJECT_UNAUTHORIZED: "1",
      HTTPS_PROXY: "", HTTP_PROXY: "", NO_PROXY: "", https_proxy: "", http_proxy: "", no_proxy: "" },
  });
  assert.deepEqual(fixture.requests.map(req => req.method), ["GET", "POST"]);
  assert.ok(fixture.requests.every(req => req.trustedOrigin && req.bearer && req.via === "direct"));
});

test("CONNECT settings precede the environment, bypass is scoped, and system routing owns an unconfigured HTTPS target", () => {
  const url = new URL("https://sub.panda.example:8443/v1");
  const env = { HTTPS_PROXY: "http://localhost:5000", NO_PROXY: ".elsewhere,panda.example:8443" };
  assert.equal(proxyRoute(url, {}, env).kind, "direct");
  assert.equal(proxyRoute(url, { noProxy: ["not.example"] }, env).proxy.href, "http://localhost:5000/");
  assert.equal(proxyRoute(url, { proxy: "https://localhost:4321", noProxy: ["other"] }, env).proxy.href, "https://localhost:4321/");
  assert.equal(proxyRoute(url, {}, {}).kind, "host");
  assert.equal(proxyRoute(url, { proxySupport: "off" }, { HTTPS_PROXY: "http://localhost:5000" }).kind, "direct");
  assert.throws(() => proxyRoute(url, { proxy: "bad" }, {}), /proxy URL/);
});

test("a real HTTP or HTTPS CONNECT tunnel keeps the bearer at the TLS origin, honors CA and bypass, and never follows redirects", async t => {
  const dir = mkdtempSync(join(tmpdir(), "panda-connect-"));
  const fixture = await proxyFixture(dir);
  t.after(async () => { await fixture.close(); rmSync(dir, { recursive: true, force: true }); });
  async function probe(settings, url = fixture.endpoint, env = {}, input) {
    const child = await run(process.execPath, [join(__dirname, "proxy-client.cjs")], { env: { ...process.env,
      https_proxy: "", http_proxy: "", HTTP_PROXY: "", HTTPS_PROXY: "", NO_PROXY: "", no_proxy: "",
      NODE_EXTRA_CA_CERTS: fixture.ca, NODE_TLS_REJECT_UNAUTHORIZED: "1",
      PANDA_PROXY_FIXTURE: JSON.stringify({ url, settings, input }), ...env } });
    return JSON.parse(child.stdout);
  }
  const good = await probe({ proxy: fixture.httpProxy, proxyAuthorization: "Bearer corporate-fixture" });
  assert.deepEqual(good.ids, ["auto:cost"]); assert.equal(good.text, "tunnel answer");
  assert.ok(good.clock.some(([method]) => method === "CONNECT"));
  assert.ok(good.clock.every(([, head, body]) => head === 600000 && body === 600000));
  assert.equal(fixture.tunnels.length, 2); assert.ok(fixture.tunnels.every(t => t.proxyAuthorization === "Bearer corporate-fixture"));
  assert.ok(fixture.requests.every(r => r.bearer && !r.proxyAuth));
  assert.ok(fixture.requests[1].key.startsWith("panda-vscode-"));
  const reused = { proxyAuthorization: "Bearer pnd_it_proxy_fixture" };
  for (const settings of [reused, { ...reused, proxy: fixture.httpProxy }]) {
    assert.match((await probe(settings)).error, /separate credentials/);
  }
  assert.equal(fixture.tunnels.length, 2);
  assert.equal((await probe({}, fixture.endpoint, { HTTPS_PROXY: fixture.httpProxy })).text, "tunnel answer");
  assert.equal(fixture.tunnels.length, 4);
  assert.equal((await probe({}, fixture.bypass, { HTTPS_PROXY: fixture.httpProxy, NO_PROXY: "localhost." })).text, "tunnel answer");
  assert.equal(fixture.tunnels.length, 4);
  assert.match((await probe({ proxy: fixture.httpsProxy })).error, /connection/);
  assert.equal(fixture.tunnels.length, 4);
  assert.equal((await probe({ proxy: fixture.httpsProxy, proxyStrictSSL: false })).text, "tunnel answer");
  assert.equal(fixture.tunnels.length, 6);
  const previouslyReceived = fixture.requests.length;
  assert.match((await probe({ proxy: fixture.httpsProxy, proxyStrictSSL: false }, fixture.untrusted)).error, /connection/);
  assert.equal(fixture.requests.length, previouslyReceived);
  assert.match((await probe({ proxy: fixture.httpProxy }, fixture.endpoint, {}, "redirect-fixture")).error, /redirect/);
  assert.ok(!fixture.requests.some(r => r.path === "/must-never-follow"));
  assert.ok(fixture.tunnels.every(t => !t.leaked && !t.hasOriginAuthorization));
  assert.ok(fixture.requests.every(r => r.bearer && !r.proxyAuth));

  const beforeDenied = fixture.requests.length;
  const authError = "The network proxy requires authentication. Check the proxy address and credentials.";
  assert.equal((await probe({ proxy: fixture.requiredHttp, proxyAuthorization: "Bearer wrong-fixture" })).error, authError);
  assert.equal((await probe({ proxy: fixture.requiredHttps, proxyStrictSSL: false })).error, authError);
  assert.match((await probe({}, fixture.untrustedDirect, { NODE_TLS_REJECT_UNAUTHORIZED: "0" })).error, /connection/);
  assert.equal(fixture.requests.length, beforeDenied);
  assert.equal((await probe({ proxy: fixture.requiredHttps, proxyAuthorization: fixture.requiredAuth,
    proxyStrictSSL: false })).text, "tunnel answer");
  const bothCAs = join(dir, "trusted.pem");
  writeFileSync(bothCAs, Buffer.concat([readFileSync(fixture.ca), readFileSync(join(dir, "proxy-ca.pem"))]));
  assert.equal((await probe({ proxy: fixture.requiredHttps, proxyAuthorization: fixture.requiredAuth,
    proxyStrictSSL: true }, fixture.endpoint, { NODE_EXTRA_CA_CERTS: bothCAs })).text, "tunnel answer");
  assert.ok(fixture.requests.every(req => req.trustedOrigin && req.bearer && !req.proxyAuth));
});
