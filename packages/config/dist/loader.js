/**
 * Configuration loader.
 *
 * Strategy: build a layered dict, lowest priority first, and shallow-merge
 * higher-priority on top. Object values are deep-merged with a hand-rolled
 * merger that respects arrays as atomic values (i.e. arrays are replaced, not
 * concatenated — that matches what users expect from YAML configs).
 *
 * Public API: {@link loadConfig}.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigSourceNotFoundError, ConfigValidationError } from './errors.js';
import { LumenConfigSchema } from './schema.js';
const DEFAULT_PROJECT_LOCATIONS = ['.lumen/config.yaml', '.lumen/config.yml', 'lumen.config.yaml'];
const DEFAULT_USER_PATH = join(homedir(), '.lumen', 'config.yaml');
/** Deep merge plain objects. Arrays and other non-plain values are replaced. */
const deepMerge = (base, override) => {
    const result = { ...base };
    for (const key of Object.keys(override)) {
        const overrideVal = override[key];
        const baseVal = result[key];
        if (overrideVal !== null &&
            typeof overrideVal === 'object' &&
            !Array.isArray(overrideVal) &&
            baseVal !== null &&
            typeof baseVal === 'object' &&
            !Array.isArray(baseVal)) {
            result[key] = deepMerge(baseVal, overrideVal);
        }
        else {
            result[key] = overrideVal;
        }
    }
    return result;
};
const readYamlIfExists = async (path) => {
    if (!existsSync(path))
        return undefined;
    const raw = await readFile(path, 'utf8');
    const parsed = parseYaml(raw);
    if (parsed === null || parsed === undefined)
        return {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ConfigSourceNotFoundError(`Config file at ${path} must be a YAML mapping, got ${Array.isArray(parsed) ? 'sequence' : typeof parsed}`);
    }
    return parsed;
};
const readEnv = (prefix) => {
    const out = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith(prefix))
            continue;
        const path = key
            .slice(prefix.length)
            .toLowerCase()
            .split('__')
            .map((segment) => segment.replace(/-/g, ''));
        if (path.length === 0)
            continue;
        // Very small env-shape interpreter:
        //   LUMEN_LOGGING__LEVEL=debug  -> { logging: { level: 'debug' } }
        //   LUMEN_DEFAULT_MODEL=foo     -> { defaultModel: 'foo' }
        let cursor = out;
        for (let i = 0; i < path.length - 1; i++) {
            const seg = path[i];
            const next = cursor[seg];
            if (next === null || typeof next !== 'object' || Array.isArray(next)) {
                const fresh = {};
                cursor[seg] = fresh;
                cursor = fresh;
            }
            else {
                cursor = next;
            }
        }
        cursor[path[path.length - 1]] = value;
    }
    return out;
};
const resolveProjectPath = (cwd, override) => {
    if (override)
        return override;
    for (const candidate of DEFAULT_PROJECT_LOCATIONS) {
        const full = join(cwd, candidate);
        if (existsSync(full))
            return full;
    }
    return undefined;
};
export const loadConfig = async (options = {}) => {
    const cwd = options.cwd ?? process.cwd();
    const envPrefix = options.envPrefix ?? 'LUMEN_';
    const userPath = options.skipUserConfig ? undefined : (options.userPath ?? DEFAULT_USER_PATH);
    const projectPath = options.skipProjectConfig
        ? undefined
        : resolveProjectPath(cwd, options.projectPath);
    const layers = [
        { name: 'built-in defaults', value: LumenConfigSchema.parse({}) },
        { name: `user config (${userPath ?? 'skipped'})`, value: userPath ? await readYamlIfExists(userPath) : undefined },
        { name: `project config (${projectPath ?? 'skipped'})`, value: projectPath ? await readYamlIfExists(projectPath) : undefined },
        { name: `env (${envPrefix}*)`, value: readEnv(envPrefix) },
        { name: 'CLI overrides', value: options.cliOverrides },
    ];
    let merged = {};
    for (const layer of layers) {
        if (!layer.value)
            continue;
        merged = deepMerge(merged, layer.value);
    }
    const result = LumenConfigSchema.safeParse(merged);
    if (!result.success) {
        throw new ConfigValidationError('Configuration failed validation', result.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
        })), { cause: result.error });
    }
    return result.data;
};
//# sourceMappingURL=loader.js.map