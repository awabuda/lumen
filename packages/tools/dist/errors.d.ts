/**
 * Filesystem-tool-specific error types.
 *
 * The `@lumen/core` package already exports {@link ToolError} and
 * {@link ToolValidationError} that cover the generic cases. This file
 * adds typed subclasses that carry filesystem-specific context (e.g. the
 * offending path) for the rare situations where that extra context is
 * useful to the caller.
 */
import { ToolError } from '@lumen/core';
/** Thrown when a filesystem operation targets a non-existent file. */
export declare class FileNotFoundError extends ToolError {
    readonly path: string;
    constructor(path: string, cause?: unknown);
}
/** Thrown when a path is not where it is expected to be (e.g. a directory where a file is required). */
export declare class PathKindError extends ToolError {
    readonly path: string;
    readonly expected: 'file' | 'dir';
    constructor(path: string, expected: 'file' | 'dir', cause?: unknown);
}
//# sourceMappingURL=errors.d.ts.map