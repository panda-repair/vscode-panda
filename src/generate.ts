import type * as vscode from "vscode";
import type { Access } from "./access";
import type { FreshOperation } from "./client";
import { GENERATE_ANOTHER, PandaError, PandaReplay } from "./errors";

type Turn = { model: string; wire: string; operation: FreshOperation; expires: NodeJS.Timeout };
const MAX_PENDING = 4;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const OFFER_LIFETIME = 5 * 60_000;

function page(text: string) {
  const safe = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" ' +
    'content="default-src \'none\'; style-src \'unsafe-inline\'"><style>pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>' +
    "<pre>" + safe + "</pre>";
}

// Only a visible replay offer holds its original wire request. No conversation
// or operation identifier needs to be written to disk to recover the same key.
export class GenerateActions implements vscode.Disposable {
  private readonly pending = new Map<symbol, Turn>();
  private readonly panels = new Set<vscode.WebviewPanel>();
  constructor(private readonly access: Access, private readonly host: Pick<typeof vscode, "window" | "ViewColumn">) {}

  private take(id: symbol) {
    const turn = this.pending.get(id);
    if (turn) { clearTimeout(turn.expires); this.pending.delete(id); }
    return turn;
  }

  clear() { for (const id of this.pending.keys()) this.take(id); }
  dispose() { this.clear(); for (const panel of this.panels) panel.dispose(); }

  offer(model: string, error: PandaReplay, wire: string, operation: FreshOperation) {
    if (Buffer.byteLength(wire) > MAX_REQUEST_BYTES) return;
    for (const turn of this.pending.values()) {
      if (turn.operation.originalKey === operation.originalKey && turn.operation.afterRun === operation.afterRun) return;
    }
    const oldest = this.pending.keys().next().value;
    if (oldest && this.pending.size >= MAX_PENDING) this.take(oldest);
    const id = Symbol();
    const expires = setTimeout(() => this.take(id), OFFER_LIFETIME).unref();
    this.pending.set(id, { model, wire, operation, expires });
    void this.prompt(id, model + " · " + error.message).catch(() => {});
  }

  private async prompt(id: symbol, message: string) {
    const answer = await this.host.window.showWarningMessage(message, GENERATE_ANOTHER);
    const turn = this.take(id);
    if (answer !== GENERATE_ANOTHER) return;
    if (!turn) {
      void this.host.window.showInformationMessage("This Panda offer expired. Retry the original turn to see its current run status.");
      return;
    }
    const panel = this.host.window.createWebviewPanel("panda.answer", "Panda answer · " + turn.model,
      this.host.ViewColumn.Beside, { enableScripts: false, localResourceRoots: [] });
    this.panels.add(panel);
    const controller = new AbortController();
    panel.onDidDispose(() => { this.panels.delete(panel); controller.abort(); });
    panel.webview.html = page("Waiting for Panda…");
    let output = "", truncated = false;
    try {
      await this.access.chat(turn.model, turn.wire, controller.signal, part => {
        const fragment = "text" in part ? part.text :
          "\n\nTool request: " + part.name + "\n" + JSON.stringify(part.input, null, 2);
        const room = 2 * 1024 * 1024 - output.length;
        if (fragment.length > room) truncated = true;
        output += fragment.slice(0, room);
      }, (error, wire, operation) => this.offer(turn.model, error, wire, operation), turn.operation);
      if (truncated) output += "\n\nPanda reached the display limit for this answer.";
      if (!controller.signal.aborted) panel.webview.html = page(output || "Panda returned an empty answer.");
    } catch (error) {
      if (!controller.signal.aborted) panel.webview.html = page(error instanceof PandaError ? error.message : "The Panda request could not be completed.");
    } finally { turn.wire = ""; }
  }
}
