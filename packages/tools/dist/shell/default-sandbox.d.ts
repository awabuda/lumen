import type { ShellSandbox, ShellSandboxConfig, ShellSandboxOutcome, ShellSandboxRequest } from './sandbox.js';
export declare class DefaultSandbox implements ShellSandbox {
    private readonly env;
    private readonly timeoutMs;
    private readonly maxOutputBytes;
    constructor(config: ShellSandboxConfig);
    run(request: ShellSandboxRequest): Promise<ShellSandboxOutcome>;
}
//# sourceMappingURL=default-sandbox.d.ts.map