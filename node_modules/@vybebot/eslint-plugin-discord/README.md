# @vybebot/eslint-plugin-discord

Type-aware ESLint rules for discord.js bots and Components V2. Catches Discord REST API limits, invalid builder configurations, and Components V2 violations at compile time before deployment.

Forked and adapted from [seedcord](https://github.com/seedcord/seedcord)'s `eslint-plugin-discordjs` with additions for `ModalBuilder` limits, command description bounds, label constraints, and pre-bundled ESLint flat config presets.

## Rules

| Rule | Description |
| --- | --- |
| `discord/no-discord-limit-exceeded` | Hard caps on builders: ActionRow (5 components), Modal (5 top-level components), SelectMenu (25 options), Embed (25 fields), SlashOption (25 choices). |
| `discord/valid-command-description` | Slash command, subcommand, and option descriptions must be 1–100 characters. |
| `discord/valid-label-length` | `LabelBuilder.setLabel()` must be 45 characters or fewer. |
| `discord/valid-text-length` | Static text over Discord's limits: embed title, description, fields, footer, and author; button labels; select menu placeholders and options; modal titles; text inputs; text displays. |
| `discord/no-unbounded-v2-components` | Warn when V2 components are added for every item of an uncapped list, which can pass the 40-component message limit. |
| `discord/no-await-before-acknowledge` | Warn when a handler awaits other work before replying or deferring, which risks `10062 Unknown interaction`. |
| `discord/no-mixed-message-format` | Disallow mixing Components V2 with `content`, `embeds`, `poll`, or `stickers`. |
| `discord/require-components-v2-flag` | Require `MessageFlags.IsComponentsV2` when sending or updating V2 components. |
| `discord/required-option-before-optional` | Disallow placing required slash command options after optional ones. |
| `discord/select-menu-min-exceeds-max` | Disallow `min_values` greater than `max_values`. |
| `discord/valid-command-name` | Enforce Discord slash command name rules (`/^[a-z0-9_-]{1,32}$/`). |
| `discord/no-conflicting-button-props` | Disallow conflicting button props (e.g., customId on link buttons). |
| `discord/require-button-props` | Require essential props based on button style. |
| `discord/no-choices-and-autocomplete` | Disallow both static choices and autocomplete on the same option. |
| `discord/prefer-ephemeral-flag` | Suggest `MessageFlags.Ephemeral` instead of deprecated `ephemeral: true`. |
| `discord/prefer-v2-component` | Suggest Components V2 where applicable. |

## Quick Start (ESLint 9+ Flat Config)

```sh
npm install -D @vybebot/eslint-plugin-discord eslint
```

In `eslint.config.js`:
```js
import vybeDiscord from '@vybebot/eslint-plugin-discord';

export default [
  ...vybeDiscord.configs.recommended,
];
```

## License

Apache-2.0
