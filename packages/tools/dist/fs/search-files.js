/**
 * `search_files` — regex content search across a directory tree.
 *
 * Strategy:
 *   1. Try to invoke `rg --json` (ripgrep). If the binary is on PATH
 *      and the call succeeds, parse its JSON-line output.
 *   2. Otherwise, fall back to a pure-Node recursive walk that
 *      applies the same regex to each line of each matching file.
 *
 * The fallback is not a full replacement for ripgrep (no `.gitignore`
 * awareness, no binary-file skip beyond extension, no parallelism
 * tuning) but it produces identical results for the shapes this tool
 * documents and is correct for the common case.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BaseTool } from '@lumen/core';
/** Zod schema for the tool's input. */
export const SearchFilesInputSchema = z.object({
    /** Regular expression source (ECMAScript syntax). */
    pattern: z.string().min(1),
    /** Directory to search in, resolved against `ctx.cwd` if relative. */
    path: z.string().min(1),
    /** Glob to filter files. Defaults to `*` (match every file). */
    glob: z.string().optional(),
    /** Cap on the number of matches returned. Defaults to 100. */
    maxResults: z.number().int().min(1).optional(),
});
/** Zod schema for the tool's output. */
export const SearchFilesOutputSchema = z.object({
    matches: z.array(z.object({
        file: z.string(),
        line: z.number().int().min(1),
        content: z.string(),
    })),
});
/** Default cap if `maxResults` is not provided. */
const DEFAULT_MAX_RESULTS = 100;
/** Tool: regex content search across a directory tree. */
export class SearchFilesTool extends BaseTool {
    name = 'search_files';
    description = 'Search file contents using a regular expression. Uses ripgrep (rg --json) if available, ' +
        'falls back to a built-in recursive walk otherwise. Glob filter limits which files are searched. ' +
        'Returns up to maxResults matches (default 100) with file, line number, and line content.';
    inputSchema = SearchFilesInputSchema;
    risk = 'safe';
    version = '0.1.0';
    async execute(input, ctx) {
        const { pattern, path: userPath, glob, maxResults } = input;
        const absPath = path.resolve(ctx.cwd, userPath);
        const cap = maxResults ?? DEFAULT_MAX_RESULTS;
        const fileGlob = glob ?? '*';
        // Validate the regex up front so a bad pattern produces a clear
        // error before we spawn a subprocess.
        try {
            new RegExp(pattern, 'g');
        }
        catch (err) {
            throw new Error(`search_files: invalid regex pattern: ${err.message}`);
        }
        const rgMatches = await tryRipgrep(absPath, fileGlob, pattern, cap, ctx.signal);
        if (rgMatches !== null) {
            return { matches: rgMatches };
        }
        const fallback = await nodeWalk(absPath, fileGlob, pattern, cap, ctx.signal);
        return { matches: fallback };
    }
    describe() {
        return { ...super.describe(), version: this.version };
    }
}
// -----------------------------------------------------------------------------
// ripgrep backend
// -----------------------------------------------------------------------------
/**
 * Try to run ripgrep and return its matches. Returns null if ripgrep is
 * not available (binary not found, non-zero exit before matches), so
 * the caller can fall back to the pure-Node implementation.
 */
async function tryRipgrep(root, glob, pattern, cap, signal) {
    return new Promise((resolve) => {
        let resolved = false;
        const finish = (v) => {
            if (resolved)
                return;
            resolved = true;
            resolve(v);
        };
        let proc;
        try {
            proc = spawn('rg', ['--json', '--no-heading', '-g', glob, pattern, root], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        }
        catch {
            finish(null);
            return;
        }
        if (proc.stdout === null || proc.stderr === null) {
            finish(null);
            return;
        }
        let buf = '';
        const matches = [];
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', (chunk) => {
            if (matches.length >= cap)
                return;
            buf += chunk;
            let nl = buf.indexOf('\n');
            while (nl !== -1) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                const ok = parseRgLine(line, cap, matches);
                if (!ok) {
                    finish(null);
                    return;
                }
                if (matches.length >= cap)
                    break;
                nl = buf.indexOf('\n');
            }
        });
        proc.stderr.on('data', () => {
            // rg writes benign progress to stderr; ignore.
        });
        proc.on('error', () => finish(null));
        proc.on('close', (code) => {
            // rg exit codes: 0 = matches, 1 = no matches, 2 = error.
            if (code === 0 || code === 1) {
                finish(matches);
            }
            else {
                finish(null);
            }
        });
        if (signal.aborted) {
            proc.kill();
            finish([]);
        }
    });
}
/**
 * Parse a single line of `rg --json` output. Returns true on success
 * (whether or not a match was appended), false on parse error.
 */
function parseRgLine(line, cap, out) {
    if (line.length === 0)
        return true;
    let obj;
    try {
        obj = JSON.parse(line);
    }
    catch {
        return false;
    }
    if (typeof obj !== 'object' || obj === null)
        return false;
    const t = obj.type;
    if (t !== 'match')
        return true;
    const data = obj.data;
    if (typeof data !== 'object' || data === null)
        return false;
    const d = data;
    if (typeof d.path?.text !== 'string')
        return false;
    if (typeof d.lines?.text !== 'string')
        return false;
    if (typeof d.line_number !== 'number')
        return false;
    out.push({
        file: d.path.text,
        line: d.line_number,
        content: d.lines.text.replace(/\r?\n$/, ''),
    });
    if (out.length >= cap)
        return true;
    return true;
}
// -----------------------------------------------------------------------------
// Pure-Node fallback
// -----------------------------------------------------------------------------
/**
 * Recursive walk that applies the regex to each line of every file
 * matching `glob`. Cap-aware — stops descending once `cap` matches
 * have been collected.
 */
async function nodeWalk(root, glob, pattern, cap, signal) {
    const matches = [];
    const matcher = makeGlobMatcher(glob);
    await walkDir(root, root, matcher, pattern, cap, matches, signal);
    return matches;
}
async function walkDir(root, current, matcher, pattern, cap, out, signal) {
    if (signal.aborted)
        throw new Error('aborted');
    if (out.length >= cap)
        return;
    const stat = await fs.lstat(current);
    if (stat.isFile()) {
        if (matcher(path.basename(current))) {
            await scanFile(current, pattern, cap, out, signal);
        }
        return;
    }
    if (!stat.isDirectory())
        return;
    const dirents = await fs.readdir(current, { withFileTypes: true });
    for (const d of dirents) {
        if (out.length >= cap)
            return;
        if (signal.aborted)
            throw new Error('aborted');
        const child = path.join(current, d.name);
        if (d.isDirectory()) {
            await walkDir(root, child, matcher, pattern, cap, out, signal);
        }
        else if (d.isFile()) {
            if (!matcher(d.name))
                continue;
            await scanFile(child, pattern, cap, out, signal);
        }
    }
}
async function scanFile(absPath, pattern, cap, out, signal) {
    let content;
    try {
        content = await fs.readFile(absPath, 'utf8');
    }
    catch {
        return; // skip unreadable files
    }
    if (signal.aborted)
        throw new Error('aborted');
    // Use a fresh, non-global RegExp per line so we don't carry state
    // across splits; .test() on a non-global regex is allocation-free.
    const r = new RegExp(pattern);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (out.length >= cap)
            return;
        const line = lines[i];
        if (r.test(line)) {
            out.push({ file: absPath, line: i + 1, content: line });
        }
    }
}
/**
 * Build a function that tests file names against a single-segment glob
 * (no path separators). Supports `*` and `?` only; this is enough for
 * the common case `*.ts`, `*.json`, etc.
 */
function makeGlobMatcher(glob) {
    if (glob === '*')
        return () => true;
    // Escape regex metacharacters except * and ?, then convert those.
    const re = new RegExp('^' +
        glob
            .split('')
            .map((c) => {
            if (c === '*')
                return '.*';
            if (c === '?')
                return '.';
            return c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        })
            .join('') +
        '$');
    return (name) => re.test(name);
}
//# sourceMappingURL=search-files.js.map