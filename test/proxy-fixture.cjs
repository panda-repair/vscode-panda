const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { execFileSync } = require("node:child_process");
const { writeFileSync, readFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { json, frame } = require("./fixture.cjs");

function certificates(dir) {
  mkdirSync(dir, { recursive: true });
  const run = (...args) => execFileSync(process.env.PANDA_TEST_OPENSSL || "openssl", args, { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "cert.cnf"), "[req]\ndistinguished_name=dn\n[dn]\n[root]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:panda-origin.invalid,DNS:panda-office.invalid,DNS:localhost.,DNS:localhost,IP:127.0.0.1\n");
  for (const name of ["origin", "proxy"]) {
    run("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=Panda test " + name + " CA", "-x509", "-days", "1",
      "-config", "cert.cnf", "-extensions", "root", "-keyout", name + "-ca.key", "-out", name + "-ca.pem");
    run("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", name + ".key", "-out", name + ".csr");
    run("x509", "-req", "-in", name + ".csr", "-CA", name + "-ca.pem", "-CAkey", name + "-ca.key", "-set_serial", "2",
      "-days", "1", "-extfile", "cert.cnf", "-extensions", "leaf", "-out", name + ".pem");
  }
  return name => ({ key: readFileSync(join(dir, name + ".key")), cert: readFileSync(join(dir, name + ".pem")) });
}

exports.proxyFixture = async function proxyFixture(dir) {
  const cert = certificates(dir);
  const tunnels = [], requests = [], sockets = new Set(), servers = [], hops = new Map();
  const bind = async server => {
    servers.push(server);
    server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    return server.address().port;
  };
  const origin = async (req, res) => {
    const bearer = req.headers.authorization === "Bearer pnd_it_proxy_fixture";
    let data = ""; for await (const chunk of req) data += chunk;
    requests.push({ method: req.method, path: req.url, bearer, proxyAuth: !!req.headers["proxy-authorization"],
      key: req.headers["idempotency-key"], body: data, trustedOrigin: req.socket.localPort === port,
      via: hops.get(req.socket.remotePort) || "direct" });
    if (!bearer) return json(res, {}, 401);
    if (req.url.endsWith("/models")) return json(res, { data: [{ id: "auto:cost" }] });
    if (data.includes("redirect-fixture")) return res.writeHead(307, { location: "/must-never-follow" }).end();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(frame({ content: "tunnel answer" }, "stop"));
  };
  const port = await bind(https.createServer(cert("origin"), origin));
  const untrustedPort = await bind(https.createServer(cert("proxy"), origin));
  const requiredAuth = "Bearer corporate-test-proxy";
  async function proxy(kind, requireAuth = false) {
    const server = kind === "https" ? https.createServer(cert("proxy")) : http.createServer();
    server.on("request", (_req, res) => res.writeHead(403).end());
    server.on("connect", (req, client, head) => {
      const [hostname, rawPort] = (req.url || "").split(":");
      const targetPort = Number(rawPort);
      if (!["panda-origin.invalid", "panda-office.invalid", "localhost."].includes(hostname) || ![port, untrustedPort].includes(targetPort)) {
        return client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      }
      const accepted = !requireAuth || req.headers["proxy-authorization"] === requiredAuth;
      tunnels.push({ kind, authority: req.url, requireAuth, accepted, hasOriginAuthorization: "authorization" in req.headers,
        proxyAuthorization: req.headers["proxy-authorization"], leaked: JSON.stringify(req.headers).includes("pnd_it_") });
      if (!accepted) return client.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Bearer realm=\"fixture\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      const target = net.connect(targetPort, "127.0.0.1", () => {
        const port = target.localPort;
        hops.set(port, kind);
        target.on("close", () => hops.delete(port));
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) target.write(head); client.pipe(target); target.pipe(client);
      });
      client.on("error", () => target.destroy()); target.on("error", () => client.destroy());
      client.on("close", () => target.destroy()); target.on("close", () => client.destroy());
    });
    return kind + "://127.0.0.1:" + await bind(server);
  }
  const httpProxy = await proxy("http"), httpsProxy = await proxy("https");
  const requiredHttp = await proxy("http", true), requiredHttps = await proxy("https", true);
  const pacReads = [];
  const pac = "function FindProxyForURL(url, host) { " +
    "if (host === 'panda-origin.invalid') return 'HTTPS " + new URL(requiredHttps).host + "'; " +
    "if (host === 'panda-office.invalid') return 'PROXY " + new URL(requiredHttp).host + "'; return 'DIRECT'; }";
  const pacPort = await bind(http.createServer((req, res) => {
    if (req.url !== "/local.pac") return res.writeHead(404).end();
    pacReads.push({ originAuth: !!req.headers.authorization, proxyAuth: !!req.headers["proxy-authorization"] });
    res.writeHead(200, { "content-type": "application/x-ns-proxy-autoconfig" }).end(pac);
  }));
  return { endpoint: "https://panda-origin.invalid:" + port + "/v1", bypass: "https://localhost.:" + port + "/v1",
    office: "https://panda-office.invalid:" + port + "/v1", untrustedDirect: "https://localhost.:" + untrustedPort + "/v1",
    requiredHttp, requiredHttps, requiredAuth, pacReads, pacUrl: "http://127.0.0.1:" + pacPort + "/local.pac",
    untrusted: "https://panda-origin.invalid:" + untrustedPort + "/v1", ca: join(dir, "origin-ca.pem"), httpProxy, httpsProxy,
    tunnels, requests, async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    } };
};
