import { createHash } from "node:crypto";
import type * as vscode from "vscode";
import type { PandaClient } from "./client";
import { models } from "./catalog";
import { PandaError } from "./errors";
import type { OutputPart } from "./stream";

export const DEFAULT_ENDPOINT = "https://app.panda.repair/v1";

export function normalizeEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new PandaError("Set a valid Panda API base URL in your user settings."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password ||
      url.href.includes("?") || url.href.includes("#")) {
    throw new PandaError("Use an HTTPS Panda API base URL without credentials, a query or a fragment. HTTP is available on loopback.");
  }
  return url.href.replace(/\/+$/, "");
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const secretSlot = (endpoint: string) => "panda.apiKey." + digest(normalizeEndpoint(endpoint));
export const validKey = (key: string | undefined): key is string => !!key && /^pnd_it_[^\s]+$/.test(key);
const changed = () => new PandaError("The Panda endpoint or API key changed. Select the model again.", "auth");
type Storage = Pick<vscode.SecretStorage, "get" | "store" | "delete">;
type Identity = { endpoint: string; key: string | undefined; epoch: AbortSignal };

export class Access {
  private epoch = new AbortController();
  private writing?: Promise<void>;
  private cache?: { endpoint: string; fingerprint: string; models: typeof models };

  constructor(private readonly secrets: Storage, private readonly endpointSetting: () => string,
    private readonly client: Pick<PandaClient, "list" | "chat">) {}

  invalidate() {
    this.cache = undefined;
    this.epoch.abort(changed());
    this.epoch = new AbortController();
  }

  async identity(signal: AbortSignal): Promise<Identity> {
    await this.writing;
    signal.throwIfAborted();
    const endpoint = normalizeEndpoint(this.endpointSetting());
    const epoch = this.epoch.signal;
    const key = await this.secrets.get(secretSlot(endpoint));
    const identity = { endpoint, epoch, key };
    this.check(identity, signal);
    return identity;
  }

  private check(identity: Identity, signal: AbortSignal) {
    signal.throwIfAborted();
    identity.epoch.throwIfAborted();
    if (normalizeEndpoint(this.endpointSetting()) !== identity.endpoint) throw changed();
  }

  private async confirm(identity: Identity, signal: AbortSignal) {
    this.check(identity, signal);
    const actual = await this.secrets.get(secretSlot(identity.endpoint));
    this.check(identity, signal);
    if (actual !== identity.key) { this.invalidate(); throw changed(); }
  }

  async list(identity: Identity, signal: AbortSignal, force = false): Promise<typeof models> {
    this.check(identity, signal);
    if (!validKey(identity.key)) return [];
    const fingerprint = digest(identity.key);
    if (!force && this.cache?.endpoint === identity.endpoint && this.cache.fingerprint === fingerprint) return this.cache.models;
    this.cache = undefined;
    const permitted = await this.client.list(identity.endpoint, identity.key, AbortSignal.any([signal, identity.epoch]));
    await this.confirm(identity, signal);
    this.check(identity, signal);
    this.cache = { endpoint: identity.endpoint, fingerprint, models: permitted };
    return permitted;
  }

  private async write(identity: Identity, key: string | undefined, signal: AbortSignal) {
    await this.confirm(identity, signal);
    this.check(identity, signal);
    this.invalidate();
    const slot = secretSlot(identity.endpoint);
    const operation = Promise.resolve(key ? this.secrets.store(slot, key) : this.secrets.delete(slot));
    this.writing = operation;
    try { await operation; } finally { this.writing = undefined; this.invalidate(); }
  }

  async set(identity: Identity, candidate: string, signal: AbortSignal) {
    this.check(identity, signal);
    const key = candidate.trim();
    if (!validKey(key)) throw new PandaError("Enter a Panda inference token beginning with pnd_it_.", "auth");
    const permitted = await this.client.list(identity.endpoint, key, AbortSignal.any([signal, identity.epoch]));
    await this.write(identity, key, signal);
    const saved = await this.identity(signal);
    if (saved.endpoint === identity.endpoint && saved.key === key) {
      this.cache = { endpoint: saved.endpoint, fingerprint: digest(key), models: permitted };
    }
    return permitted;
  }

  clear(identity: Identity, signal: AbortSignal) { return this.write(identity, undefined, signal); }

  async chat(id: string, body: object, signal: AbortSignal, report: (part: OutputPart) => void) {
    if (!models.some(model => model.id === id)) throw new PandaError("This Panda model is unavailable.", "model");
    const identity = await this.identity(signal);
    if (!validKey(identity.key)) throw new PandaError("Set your Panda API key using Panda: Manage API Key.", "auth");
    const grants = await this.list(identity, signal, true);
    if (!grants.some(row => row.id === id)) throw new PandaError("This Panda key has no grant for the selected model.", "auth");
    this.check(identity, signal);
    await this.client.chat(identity.endpoint, identity.key, body, AbortSignal.any([signal, identity.epoch]), report);
  }
}
