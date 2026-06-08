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
export class FileNotFoundError extends ToolError {
    path;
    constructor(path, cause) {
        super(`File not found: ${path}`, { toolName: 'filesystem', cause });
        this.name = 'FileNotFoundError';
        this.path = path;
    }
}
/** Thrown when a path is not where it is expected to be (e.g. a directory where a file is required). */
export class PathKindError extends ToolError {
    path;
    expected;
    constructor(path, expected, cause) {
        super(`Path ${path} is not a ${expected}`, { toolName: 'filesystem', cause });
        this.name = 'PathKindError';
        this.path = path;
        this.expected = expected;
    }
}
//# sourceMappingURL=errors.js.map