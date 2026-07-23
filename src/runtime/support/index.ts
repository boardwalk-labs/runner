// SPDX-License-Identifier: Apache-2.0

// Runtime support shims — a small, self-contained slice of the error taxonomy and logging the
// worker runtime depends on. The AppError taxonomy mirrors the platform's error codes so brokered
// responses map cleanly; the logger emits structured JSON to stdout.

import { randomUUID } from "node:crypto";

// ---- errors (the shared AppError taxonomy — mirrors the platform's error codes so brokered
// responses deserialize to the same shape) ----

export enum ErrorCode {
  VALIDATION_FAILED = "VALIDATION_FAILED",
  IDEMPOTENCY_KEY_REUSED = "IDEMPOTENCY_KEY_REUSED",
  MISSING_IDEMPOTENCY_KEY = "MISSING_IDEMPOTENCY_KEY",
  UNAUTHORIZED = "UNAUTHORIZED",
  FORBIDDEN = "FORBIDDEN",
  TWO_FACTOR_REQUIRED = "TWO_FACTOR_REQUIRED",
  BUDGET_EXCEEDED = "BUDGET_EXCEEDED",
  INSUFFICIENT_CREDITS = "INSUFFICIENT_CREDITS",
  BILLING_GATED = "BILLING_GATED",
  UPGRADE_REQUIRED = "UPGRADE_REQUIRED",
  NOT_FOUND = "NOT_FOUND",
  CONFLICT = "CONFLICT",
  CONCURRENCY_LIMIT = "CONCURRENCY_LIMIT",
  WORKFLOW_DISABLED = "WORKFLOW_DISABLED",
  UNSUPPORTED_TRIGGER = "UNSUPPORTED_TRIGGER",
  RATE_LIMIT = "RATE_LIMIT",
  TOOL_ERROR = "TOOL_ERROR",
  INTERNAL_ERROR = "INTERNAL_ERROR",
}

const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  [ErrorCode.VALIDATION_FAILED]: 400,
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: 409,
  [ErrorCode.MISSING_IDEMPOTENCY_KEY]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.TWO_FACTOR_REQUIRED]: 403,
  [ErrorCode.BUDGET_EXCEEDED]: 402,
  [ErrorCode.INSUFFICIENT_CREDITS]: 402,
  [ErrorCode.BILLING_GATED]: 402,
  [ErrorCode.UPGRADE_REQUIRED]: 402,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.CONCURRENCY_LIMIT]: 409,
  [ErrorCode.WORKFLOW_DISABLED]: 409,
  [ErrorCode.UNSUPPORTED_TRIGGER]: 422,
  [ErrorCode.RATE_LIMIT]: 429,
  [ErrorCode.TOOL_ERROR]: 500,
  [ErrorCode.INTERNAL_ERROR]: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly detail?: unknown;

  constructor(code: ErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = ERROR_HTTP_STATUS[code];
    this.detail = detail;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** A machine-readable error code is SCREAMING_SNAKE — an engine `EngineError.code` (`VALIDATION`,
 *  `PROVIDER_ERROR`, …), an {@link AppError} code, and a Node syscall code (`ENOENT`) all are. */
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The SEMANTIC code of a thrown value, or undefined when it carries none. Duck-typed rather than
 * `instanceof` — errors cross package boundaries (SDK/engine dual copies), where class checks fail.
 * The SCREAMING_SNAKE shape gate keeps prose out of a field consumers render as a code.
 */
export function errorCodeOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code: unknown = (err as { code?: unknown }).code;
  return typeof code === "string" && ERROR_CODE_RE.test(code) ? code : undefined;
}

// ---- leases ----

/** Run-lease heartbeat period (ported from the platform's checkpoint module — the broker's
 *  renew endpoint mirrors it). */
export const DEFAULT_LEASE_MS = 5 * 60 * 1000;

// ---- ids ----

/** Opaque unique id (metering sessions, worker ids). Not a ULID — nothing here sorts by it. */
export function newId(): string {
  return randomUUID();
}

// ---- logger (structured JSON to stdout; same call surface as the platform logger) ----

type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const LEVEL_ORDER: Record<string, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

/** Numeric log level from an env: BOARDWALK_RUNNER_LOG_LEVEL (debug|info|warn|error), default info;
 *  BOARDWALK_RUNNER_DEBUG=1 is a legacy alias for debug. Reads the passed `env`, not process.env. */
function levelFromEnv(env: NodeJS.ProcessEnv): number {
  if (env.BOARDWALK_RUNNER_DEBUG === "1") return LEVEL_ORDER.DEBUG ?? 10;
  const name = env.BOARDWALK_RUNNER_LOG_LEVEL?.toUpperCase() ?? "INFO";
  return LEVEL_ORDER[name] ?? 20;
}

/** The level frozen at worker bootstrap from the TRUSTED boot env, or null until then. */
let configuredLevel: number | null = null;

/**
 * Freeze the runner's log level from a TRUSTED env — the platform boot env, snapshotted before the
 * identity relay overlays a run's author env onto process.env (see `main`). Call once at bootstrap.
 *
 * Until it's called — in tests, and in the CLI/daemon before boot — {@link activeLevel} falls back to
 * reading process.env live, so an operator's `--verbose`/`--debug` (which sets the env BEFORE boot,
 * bin.ts) still applies. After it's called, a workflow author's `meta.env` (overlaid onto process.env
 * at run time) can no longer raise the runner's own log verbosity. An author-facing verbosity control
 * belongs in the manifest `meta` (e.g. a `logVerbosity` field), delivered over the trusted control
 * plane — never an env knob.
 */
export function configureLogging(env: NodeJS.ProcessEnv): void {
  configuredLevel = levelFromEnv(env);
}

function activeLevel(): number {
  return configuredLevel ?? levelFromEnv(process.env);
}

function emit(level: string, module: string, message: string, fields?: LogFields): void {
  if ((LEVEL_ORDER[level] ?? 20) < activeLevel()) return;
  const line = JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    module,
    ...fields,
  });
  if (level === "ERROR" || level === "WARN") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function createLogger(module: string): Logger {
  return {
    debug: (m, f) => {
      emit("DEBUG", module, m, f);
    },
    info: (m, f) => {
      emit("INFO", module, m, f);
    },
    warn: (m, f) => {
      emit("WARN", module, m, f);
    },
    error: (m, f) => {
      emit("ERROR", module, m, f);
    },
  };
}

// ---- auth context (type-only port of domain/authz — the runtime SYNTHESIZES one for tool
// context; it never authenticates anything itself) ----

export type OrgRole = "owner" | "admin" | "member" | "viewer";
export type AuthSource = "session_jwt" | "oauth_jwt" | "api_key" | "workflow";

export interface AuthContext {
  userId: string;
  source: AuthSource;
  orgId: string;
  role: OrgRole;
  apiKeyId?: string;
  scopes?: readonly string[];
  boundOrgId?: string;
  boundRole?: OrgRole;
}
