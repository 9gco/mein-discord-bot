import { TSESLint } from '@typescript-eslint/utils';

declare const plugin: TSESLint.FlatConfig.Plugin;
declare const recommended: TSESLint.FlatConfig.ConfigArray;
declare function createSharedProgramConfig(program: unknown, tsconfigRootDir?: string): TSESLint.FlatConfig.ConfigArray;

export { createSharedProgramConfig, plugin as default, recommended };
