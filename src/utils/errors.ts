import { DiscordAPIError } from "discord.js";

/**
 * An error whose message is written for whoever is running the bot: it says
 * what is wrong and what to change. Startup logs it on its own — no stack
 * trace, no raw API payload — because neither adds anything to it.
 */
/**
 * Raised when a dashboard identity's Discord OAuth tokens can no longer be
 * refreshed (the refresh token has expired or been revoked). The user must
 * sign in again — the API maps this to a 401 so the website takes them to the
 * login screen instead of showing a generic server error.
 */
export class AuthSessionExpiredError extends Error {
  constructor(message = "Your dashboard session has expired. Please sign in again.") {
    super(message);
    this.name = "AuthSessionExpiredError";
  }
}

export class StartupError extends Error {
  /** The failure this was derived from, kept for debugging. */
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "StartupError";
    this.cause = cause;
  }
}

const INVALID_TOKEN =
  "DISCORD_TOKEN is invalid — Discord rejected it with 401 Unauthorized. " +
  "Reset the token in the Discord Developer Portal (Applications -> your app -> Bot -> " +
  "Reset Token), set DISCORD_TOKEN to the new value, and redeploy. Make sure the value " +
  "is the bot token itself, not the client secret or public key, and that it was copied " +
  "whole with no stray spaces or quotes.";

/**
 * Turn a failure from the Discord REST API into a `StartupError` naming the
 * setting to fix. Anything unrecognised is returned as-is so it still surfaces
 * with its full detail.
 */
export function describeDeployFailure(err: unknown, clientId: string): unknown {
  if (!(err instanceof DiscordAPIError)) {
    return err;
  }

  switch (err.status) {
    case 401:
      return new StartupError(INVALID_TOKEN, err);
    case 403:
      return new StartupError(
        `Discord refused to register commands for application ${clientId} (403 Forbidden). ` +
          "This usually means DISCORD_TOKEN belongs to a different application than " +
          "DISCORD_CLIENT_ID, or the bot was invited without the applications.commands scope. " +
          "Check both values in the Developer Portal and re-invite the bot if needed.",
        err,
      );
    case 404:
      return new StartupError(
        `Discord does not recognise application ${clientId} (404 Not Found). Set ` +
          "DISCORD_CLIENT_ID to the Application ID from the Developer Portal " +
          "(General Information -> Application ID).",
        err,
      );
    default:
      return err;
  }
}

/**
 * Same idea for the gateway login, which fails with a discord.js error code
 * rather than an HTTP status.
 */
export function describeLoginFailure(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code;

  if (code === "TokenInvalid") {
    return new StartupError(INVALID_TOKEN, err);
  }
  if (code === "DisallowedIntents") {
    return new StartupError(
      "The bot requested a privileged intent that is not enabled for it. Turn the intent on " +
        "in the Discord Developer Portal (Applications -> your app -> Bot -> Privileged " +
        "Gateway Intents), or drop it from the intents list in src/index.ts.",
      err,
    );
  }
  return err;
}
