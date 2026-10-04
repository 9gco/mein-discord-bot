interface CliOptions {
    projectDir: string;
    tsconfigPath: string;
}
declare function parseArgs(args: string[]): {
    options: CliOptions;
    help: boolean;
    version: boolean;
};
declare function runCli(args?: string[]): Promise<number>;

export { type CliOptions, parseArgs, runCli };
