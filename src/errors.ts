export class PandaError extends Error {
  constructor(message: string, readonly kind: "auth" | "blocked" | "model" | "request" = "request") {
    super(message);
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

export function responseError(status: number, payload: unknown, key: string) {
  const error = record(payload) && record(payload.error) ? payload.error : {};
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
  if (status === 409) return new PandaError("Panda reported a request conflict or replay. The earlier request may already have run and been charged.");
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
