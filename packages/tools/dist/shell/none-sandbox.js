export class NoneSandbox {
    // Config is accepted to satisfy the contract; this sandbox
    // ignores it because it has no parameters at all.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_config) { }
    run(_request) {
        return Promise.resolve({
            kind: 'refused',
            reason: 'policy-disabled',
            message: 'Shell execution is disabled by policy. The "none" sandbox strategy is configured; ' +
                'change the strategy to "default" (or a registered alternative) to enable the terminal tool.',
        });
    }
}
//# sourceMappingURL=none-sandbox.js.map