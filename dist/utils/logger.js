function timestamp() {
    return new Date().toISOString();
}
function serializeError(err) {
    if (err instanceof Error) {
        const errorObject = {
            message: err.message,
            stack: err.stack,
            name: err.name,
        };
        for (const key of Object.keys(err)) {
            errorObject[key] = err[key];
        }
        return errorObject;
    }
    return err;
}
function log(level, message, meta) {
    let msgStr = "";
    const serializedMeta = {};
    if (message instanceof Error) {
        msgStr = message.message;
        serializedMeta["error"] = serializeError(message);
    }
    else {
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
    info(message, meta) {
        log("info", message, meta);
    },
    warn(message, meta) {
        log("warn", message, meta);
    },
    error(message, meta) {
        log("error", message, meta);
    },
    debug(message, meta) {
        if (process.env["LOG_LEVEL"] === "debug") {
            log("debug", message, meta);
        }
    },
};
