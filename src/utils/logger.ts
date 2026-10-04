type LogLevel = "info" | "warn" | "error" | "debug";

function timestamp(): string {
  return new Date().toISOString();
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    const errorObject: Record<string, unknown> = {
      message: err.message,
      stack: err.stack,
      name: err.name,
    };
    // Copy any enumerable custom properties
    for (const key of Object.keys(err)) {
      errorObject[key] = (err as any)[key];
    }
    return errorObject;
  }
  return err;
}

function log(
  level: LogLevel,
  message: string | Error,
  meta?: Record<string, unknown>,
): void {
  let msgStr = "";
  const serializedMeta: Record<string, unknown> = {};

  if (message instanceof Error) {
    msgStr = message.message;
    serializedMeta["error"] = serializeError(message);
  } else {
    msgStr = message;
  }

  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      serializedMeta[key] = serializeError(value);
    }
  }

  const entry = {
    ts: timestamp(),
    level,
    message: msgStr,
    ...serializedMeta,
  };
  const out = level === "error" ? process.stderr : process.stdout;
  out.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  info(message: string | Error, meta?: Record<string, unknown>): void {
    log("info", message, meta);
  },
  warn(message: string | Error, meta?: Record<string, unknown>): void {
    log("warn", message, meta);
  },
  error(message: string | Error, meta?: Record<string, unknown>): void {
    log("error", message, meta);
  },
  debug(message: string | Error, meta?: Record<string, unknown>): void {
    if (process.env["LOG_LEVEL"] === "debug") {
      log("debug", message, meta);
    }
  },
};
