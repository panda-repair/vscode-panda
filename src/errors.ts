export class PandaError extends Error {
  constructor(message: string, readonly kind: "auth" | "blocked" | "model" | "request" = "request") {
    super(message);
  }
}

export const GENERATE_ANOTHER = "Generate another answer (may incur a charge)";
export const PROXY_AUTH_REQUIRED = "The network proxy requires authentication. Check the proxy address and credentials.";

export class PandaOutputLimit extends PandaError {
  constructor() { super("Panda reached the output token limit. The response is incomplete."); }
}

export class PandaReplay extends PandaError {
  constructor(readonly runId: string, summary: string) {
    super(summary + " The retry adds no charge and has no answer. “" + GENERATE_ANOTHER +
      "” is available. Choose this action to request this run's follow-up. If Panda already accepted it, you'll see its status and any settled charge.");
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicMessage(value: unknown, token: string) {
  if (typeof value !== "string") return "";
  return value.replaceAll(token, "[redacted]").replace(/pnd_it_[^\s"'<>]+/gi, "[redacted]")
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]+/g, " ").trim().slice(0, 320);
}

function replayError(payload: unknown, token: string, headerRunId?: string) {
  const error = record(payload) && record(payload.error) ? payload.error : {};
  if (error.code === "mixture_idempotency_conflict") {
    return new PandaError("Panda rejected this idempotency key because it belongs to a different request body. This request did not start a new run.");
  }
  const status = typeof error.code === "string" ? /^mixture_already_(running|completed|partial|failed)$/.exec(error.code)?.[1] : undefined;
  const panda = record(payload) && record(payload.panda) ? payload.panda : {};
  if (!status || panda.replay !== true || panda.status !== status || panda.version !== "panda.chat.v1") {
    return new PandaError("Panda reported an unverified request conflict or replay (HTTP 409). Its outcome and charge are unknown.");
  }
  const candidate = panda.run_id ?? headerRunId;
  const runId = typeof candidate === "string" && /^[a-z0-9][a-z0-9._:/-]{0,255}$/i.test(candidate) &&
    !candidate.toLowerCase().includes("pnd_it_") && !candidate.includes(token) && (!headerRunId || headerRunId === candidate)
    ? candidate : undefined;
  let summary = "Panda run" + (runId ? " " + runId : "") + " is " + status + " (HTTP 409).";
  const charge = panda.charge;
  if (status !== "running" && record(charge) && charge.schema_version === "panda.usd-amount.v1" &&
      charge.currency === "USD" && typeof charge.minor_units === "string" && /^(0|[1-9][0-9]{0,11})$/.test(charge.minor_units)) {
    const cents = charge.minor_units.padStart(3, "0");
    summary += " Settled charge: USD " + cents.slice(0, -2) + "." + cents.slice(-2) + ".";
  } else summary += status === "running" ? " Its charge has not settled." : " The settled charge is unavailable.";
  return runId ? new PandaReplay(runId, summary) : new PandaError(summary + " The retry adds no charge and has no answer.");
}

export function responseError(status: number, payload: unknown, key: string, headerRunId?: string) {
  const error = record(payload) && record(payload.error) ? payload.error : {};
  if (status === 407) return new PandaError(PROXY_AUTH_REQUIRED);
  if (status === 401) return new PandaError("The Panda API key is wrong or expired. Update it with Panda: Manage API Key.", "auth");
  if (status === 403) return new PandaError("This Panda key does not permit the requested operation.", "auth");
  if (status === 402 || status === 429) {
    const detail = publicMessage(error.message, key);
    const title = status === 402 ? "Panda balance is insufficient." : "Panda reached a balance, rate or concurrency limit.";
    return new PandaError(detail ? title + " " + detail : title, "blocked");
  }
  if (status === 400 && error.code === "context_length_exceeded") {
    return new PandaError("This conversation exceeds the Panda route's context limit. Shorten it or request fewer output tokens.");
  }
  if (status >= 300 && status < 400) return new PandaError("The Panda endpoint returned a redirect. Check the API base URL.");
  if (status === 409) return replayError(payload, key, headerRunId);
  if (status >= 500) return new PandaError("Panda could not complete the response. A chat request may already have run and been charged.");
  return new PandaError("Panda rejected the request (HTTP " + status + ").");
}

export function streamError(error: unknown, outerStatus: unknown, key: string) {
  const details = record(error) ? error : {};
  const status = details.status ?? outerStatus;
  const statuses: Record<string, number> = {
    context_length_exceeded: 400, inference_token_invalid: 401, insufficient_workspace_balance: 402,
    throttle_mixture_concurrency_exhausted: 429, throttle_workspace_rate_limited: 429,
  };
  const codeStatus = typeof details.code === "string" && Object.hasOwn(statuses, details.code) ? statuses[details.code] : undefined;
  const httpStatus = typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : codeStatus;
  return responseError(httpStatus ?? 500, { error: details }, key);
}
