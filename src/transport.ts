import { globalAgent, request as hostRequest } from "https";
import { validateHeaderValue, type IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";
import { getCACertificates } from "node:tls";
import { Agent, Pool, ProxyAgent, errors, request } from "undici";
import { PandaError, PROXY_AUTH_REQUIRED, record } from "./errors";

export const IDLE_TIMEOUT_MS = 600_000;
const timeouts = { headersTimeout: IDLE_TIMEOUT_MS, bodyTimeout: IDLE_TIMEOUT_MS };
export type NetworkSettings = {
  proxy?: string; noProxy?: string[]; proxySupport?: string; proxyStrictSSL?: boolean;
  systemCertificates?: boolean; proxyAuthorization?: string;
};
export type Response = { statusCode: number; headers: IncomingHttpHeaders; body: Readable };

function bypass(url: URL, entries: string[]) {
  const host = url.hostname.toLowerCase();
  return entries.some(value => {
    const entry = value.trim().toLowerCase();
    if (entry === "*") return true;
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry);
    if (!match || (match[2] && match[2] !== (url.port || "443"))) return false;
    const name = match[1]!.replace(/^\*?\./, "");
    return host === name || host.endsWith("." + name);
  });
}

export function proxyRoute(url: URL, settings: NetworkSettings, env: NodeJS.ProcessEnv = process.env) {
  // Plain HTTP is accepted only on loopback. It must never carry a key over a forwarding proxy.
  if (url.protocol === "http:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      settings.proxySupport === "off") return { kind: "direct" } as const;
  const exclusions = settings.noProxy?.length ? settings.noProxy : (env.no_proxy || env.NO_PROXY || "").split(",");
  if (bypass(url, exclusions)) return { kind: "direct" } as const;
  const address = settings.proxy || env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY;
  if (!address) return { kind: "host" } as const;
  let proxy: URL;
  try { proxy = new URL(address); } catch { throw new PandaError("Check the proxy URL in VS Code or your environment."); }
  if (["socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"].includes(proxy.protocol)) return { kind: "host", proxy } as const;
  if (!["http:", "https:"].includes(proxy.protocol) || proxy.pathname !== "/" || proxy.search || proxy.hash) {
    throw new PandaError("Set a valid HTTP or HTTPS CONNECT proxy URL.");
  }
  return { kind: "proxy", proxy } as const;
}

function timeoutError() { return Object.assign(new Error("Panda connection timed out"), { code: "PANDA_TIMEOUT" }); }

// VS Code patches its extension's native HTTPS request to resolve the system proxy and PAC.
// Explicit timeouts here cover the connection/headers and each subsequent body idle period.
function systemRequest(url: URL, headers: Record<string, string>, body: string | undefined, signal: AbortSignal,
  settings: NetworkSettings): Promise<Response> {
  return new Promise((resolve, reject) => {
    const ca = systemRoots(settings.systemCertificates);
    const req = hostRequest(url, { method: body === undefined ? "GET" : "POST", headers, signal, ca, rejectUnauthorized: true }, res => {
      clearTimeout(timer);
      res.setTimeout(IDLE_TIMEOUT_MS, () => res.destroy(timeoutError()));
      resolve({ statusCode: res.statusCode!, headers: res.headers, body: res });
    });
    const timer = setTimeout(() => req.destroy(timeoutError()), IDLE_TIMEOUT_MS).unref();
    req.once("error", error => { clearTimeout(timer); reject(error); });
    // VS Code gives each native request its own PacProxyAgent. Its public opts
    // configure the CONNECT hop after PAC resolution, separately from origin TLS.
    const agent = "agent" in req ? req.agent : undefined;
    if (agent !== globalAgent && record(agent) && typeof agent.resolver === "function" &&
        typeof agent.addCAs === "function" && record(agent.opts)) {
      agent.opts.ca = ca;
      agent.opts.rejectUnauthorized = settings.proxyStrictSSL !== false;
      if (settings.proxyAuthorization) {
        agent.opts.headers = { "Proxy-Authorization": settings.proxyAuthorization };
        agent.opts.lookupProxyAuthorization = undefined; // The user's configured credential owns this CONNECT.
      }
    } else if (settings.proxyAuthorization || settings.proxyStrictSSL === false) {
      req.destroy(new PandaError("Set an explicit HTTP or HTTPS proxy in VS Code to apply these proxy settings."));
      return;
    }
    req.end(body);
  });
}

let trusted: string[] | undefined;
function systemRoots(enabled: boolean | undefined) {
  if (enabled === false) return undefined;
  trusted ??= [...new Set([...getCACertificates("default"), ...getCACertificates("system")])];
  return trusted;
}

export class Transport {
  private readonly direct = new Agent({ ...timeouts, pipelining: 0, allowH2: false });
  private readonly lifetime = new AbortController();
  constructor(private readonly settings: () => NetworkSettings) {}
  async close() { this.lifetime.abort(); await this.direct.destroy(); }

  async exchange<T>(address: string, key: string, headers: Record<string, string>, body: string | undefined,
    signal: AbortSignal, consume: (response: Response) => Promise<T>): Promise<T> {
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    signal.throwIfAborted();
    const url = new URL(address);
    const settings = this.settings();
    const route = proxyRoute(url, settings);
    let scoped: Agent | ProxyAgent | undefined, response: Response | undefined;
    try {
      const auth = settings.proxyAuthorization || "";
      if (route.kind !== "direct") {
        if (auth) {
          try { validateHeaderValue("Proxy-Authorization", auth); }
          catch { throw new PandaError("Check the proxy credentials in VS Code."); }
        }
        const proxy = "proxy" in route ? route.proxy : undefined;
        const credentials = proxy ? decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password) : "";
        const basic = /^Basic\s+([\w+/=]+)$/i.exec(auth);
        if ([auth, credentials, basic ? Buffer.from(basic[1]!, "base64").toString("utf8") : ""].some(value =>
          value.includes(key) || /pnd_it_/i.test(value))) throw new PandaError("Use separate credentials for Panda and the proxy.");
      }
      if (route.kind === "host") response = await systemRequest(url, headers, body, signal, settings);
      else {
        if (route.kind === "proxy") {
          const ca = systemRoots(settings.systemCertificates);
          scoped = new ProxyAgent({ uri: route.proxy.href, proxyTunnel: true, token: auth || undefined,
            ...timeouts, pipelining: 0, allowH2: false,
            proxyTls: { ca, rejectUnauthorized: settings.proxyStrictSSL !== false },
            requestTls: { ca, rejectUnauthorized: true, servername: url.hostname },
            clientFactory: (origin, connection) => new Pool(origin, { ...connection, ...timeouts, pipelining: 0, allowH2: false })
              .compose(dispatch => (options, handler) => dispatch({ ...options, ...timeouts }, handler)) });
        } else if (url.protocol === "https:") {
          scoped = new Agent({ ...timeouts, pipelining: 0, allowH2: false,
            connect: { ca: systemRoots(settings.systemCertificates), rejectUnauthorized: true } });
        }
        response = await request(url, { dispatcher: scoped ?? this.direct, method: body === undefined ? "GET" : "POST",
          headers, body, signal, ...timeouts, idempotent: false });
      }
      return await consume(response);
    } catch (error) {
      // Undici 7.30 reports a rejected CONNECT as an abort, outside the HTTP response path.
      if (route.kind === "proxy" && error instanceof errors.RequestAbortedError &&
          error.message === "Proxy response (407) !== 200 when HTTP Tunneling") throw new PandaError(PROXY_AUTH_REQUIRED);
      throw error;
    } finally {
      if (response) { response.body.on("error", () => {}); response.body.destroy(); }
      if (scoped) await scoped.destroy();
    }
  }
}
