import errcode from "err-code";
import { serializeError } from "serialize-error";

export type FaultKind =
  | "auth"
  | "rate_limit"
  | "transport"
  | "tool"
  | "model"
  | "policy"
  | "storage"
  | "hook"
  | "timeout"
  | "cancelled"
  | "validation"
  | "unknown";

export type FaultSeverity = "info" | "warn" | "error" | "fatal";

export type FaultSource =
  | "execution"
  | "gateway"
  | "tool"
  | "model"
  | "storage"
  | "hook";

export type Fault = {
  kind: FaultKind;
  code: string;
  message: string;
  retryable: boolean;
  severity: FaultSeverity;
  source: FaultSource;
  cause?: unknown;
};

export type FaultPhase =
  | "ingress"
  | "session"
  | "prompt"
  | "agent"
  | "execution"
  | "response";

export type FaultEnvelope = {
  fault: Fault;
  phase: FaultPhase;
  threadId?: string;
  turnId?: string;
  runId?: string;
  startedAt: number;
  durationMs?: number;
};

const faultEnvelopeStore = new WeakMap<object, FaultEnvelope>();

export const classifyError = (error: unknown): Fault => {
  const message = normalizeMessage(error);
  const code = normalizeCode(error) ?? "unknown_error";
  const promptCategory = parsePromptCategory(message);
  const normalized = message.toLowerCase();

  if (promptCategory) {
    return mapPromptCategory(promptCategory, message, error);
  }

  if (includesAny(normalized, ["rate limit", "too many requests", "429"])) {
    return {
      kind: "rate_limit",
      code,
      message,
      retryable: true,
      severity: "warn",
      source: "model",
      cause: error,
    };
  }

  if (
    includesAny(normalized, [
      "unauthorized",
      "forbidden",
      "invalid api key",
      "authentication",
      "permission denied",
      "insufficient_quota",
      "401",
      "403",
    ])
  ) {
    return {
      kind: "auth",
      code,
      message,
      retryable: false,
      severity: "fatal",
      source: "model",
      cause: error,
    };
  }

  if (includesAny(normalized, ["timeout", "timed out", "etimedout"])) {
    return {
      kind: "timeout",
      code,
      message,
      retryable: true,
      severity: "warn",
      source: "model",
      cause: error,
    };
  }

  if (
    includesAny(normalized, [
      "econnreset",
      "econnrefused",
      "etimedout",
      "enotfound",
      "network",
      "fetch failed",
      "socket hang up",
      "temporarily unavailable",
      "service unavailable",
      "gateway timeout",
      "bad gateway",
      "web server is down",
      "host error",
      "origin error",
      "cloudflare",
    ])
    || hasRetryableServerStatus(normalized)
  ) {
    return {
      kind: "transport",
      code,
      message,
      retryable: true,
      severity: "warn",
      source: "model",
      cause: error,
    };
  }

  if (
    includesAny(normalized, [
      "invalid request",
      "bad request",
      "context length",
      "maximum context",
      "token limit",
      "model does not exist",
      "unsupported",
      "400",
    ])
  ) {
    return {
      kind: "validation",
      code,
      message,
      retryable: false,
      severity: "error",
      source: "model",
      cause: error,
    };
  }

  if (includesAny(normalized, ["aborted", "abort"])) {
    return {
      kind: "cancelled",
      code,
      message,
      retryable: false,
      severity: "info",
      source: "execution",
      cause: error,
    };
  }

  if (includesAny(normalized, ["tool", "workspace", "apply_patch"])) {
    return {
      kind: "tool",
      code,
      message,
      retryable: false,
      severity: "error",
      source: "tool",
      cause: error,
    };
  }

  return {
    kind: "unknown",
    code,
    message,
    retryable: true,
    severity: "error",
    source: "execution",
    cause: error,
  };
};

export const attachFaultEnvelope = (
  error: unknown,
  envelope: FaultEnvelope,
): unknown => {
  if (error && typeof error === "object") {
    faultEnvelopeStore.set(error, envelope);
    return error;
  }

  const wrapped = errcode(new Error(envelope.fault.message, { cause: error }), envelope.fault.code);
  faultEnvelopeStore.set(wrapped, envelope);
  return wrapped;
};

export const getFaultEnvelope = (error: unknown): FaultEnvelope | undefined => {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  return faultEnvelopeStore.get(error);
};

export const serializeFaultError = (error: unknown): Record<string, unknown> => {
  return serializeError(error) as Record<string, unknown>;
};

const normalizeMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }
  return "Unknown error";
};

const normalizeCode = (error: unknown): string | undefined => {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.trim().length > 0) {
      return code;
    }
  }
  return undefined;
};

const parsePromptCategory = (message: string): string | null => {
  const matchResult = /^\[(\w+)\]\s+/.exec(message);
  if (!matchResult) {
    return null;
  }
  return matchResult[1] ?? null;
};

const mapPromptCategory = (
  category: string,
  message: string,
  cause: unknown,
): Fault => {
  switch (category) {
    case "timeout":
      return {
        kind: "timeout",
        code: "prompt_timeout",
        message,
        retryable: true,
        severity: "warn",
        source: "model",
        cause,
      };
    case "rate_limit":
      return {
        kind: "rate_limit",
        code: "prompt_rate_limit",
        message,
        retryable: true,
        severity: "warn",
        source: "model",
        cause,
      };
    case "network":
      return {
        kind: "transport",
        code: "prompt_network",
        message,
        retryable: true,
        severity: "warn",
        source: "model",
        cause,
      };
    case "auth":
      return {
        kind: "auth",
        code: "prompt_auth",
        message,
        retryable: false,
        severity: "fatal",
        source: "model",
        cause,
      };
    case "input":
      return {
        kind: "validation",
        code: "prompt_input",
        message,
        retryable: false,
        severity: "error",
        source: "model",
        cause,
      };
    case "tool":
      return {
        kind: "tool",
        code: "prompt_tool",
        message,
        retryable: false,
        severity: "error",
        source: "tool",
        cause,
      };
    case "aborted":
      return {
        kind: "cancelled",
        code: "prompt_aborted",
        message,
        retryable: false,
        severity: "info",
        source: "execution",
        cause,
      };
    default:
      return {
        kind: "unknown",
        code: "prompt_unknown",
        message,
        retryable: true,
        severity: "error",
        source: "execution",
        cause,
      };
  }
};

const hasRetryableServerStatus = (normalizedMessage: string): boolean => {
  return /\b5\d{2}\b/.test(normalizedMessage);
};

const includesAny = (value: string, needles: string[]): boolean => {
  const lower = value.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
};
