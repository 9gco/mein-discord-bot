import { Client, Collection, GatewayIntentBits } from "discord.js";
export class BotClient extends Client {
    constructor() {
        super({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.DirectMessages,
                GatewayIntentBits.DirectMessageReactions,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.GuildVoiceStates,
            ],
        });
        this.commands = new Collection();
    }
}
let activeClient;
export function setClient(client) {
    activeClient = client;
}
export function getClient() {
    if (!activeClient)
        throw new Error("Discord client has not been registered.");
    return activeClient;
}
export function getClientIfAvailable() {
    return activeClient;
}
export function isClientReady() {
    return activeClient?.isReady() === true;
}
