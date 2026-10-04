import { describe, expect, it } from "vitest";
import { BotClient, getClient, isClientReady, setClient } from "./client.js";

describe("Discord client registry", () => {
  it("registers the host client without requiring a dashboard API", () => {
    const client = new BotClient();
    setClient(client);

    expect(getClient()).toBe(client);
    expect(isClientReady()).toBe(false);
  });
});
