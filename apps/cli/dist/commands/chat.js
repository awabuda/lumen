/**
 * Stub for the Ink TUI chat command. The real implementation is in
 * `chat.tsx` and is loaded by the TUI command module.
 *
 * This stub exists so the import in `index.ts` resolves during early
 * development and tests. When the TUI module is ready, replace this
 * with a re-export.
 */
export const chatCommand = async (_options) => {
    process.stderr.write('lumen chat: TUI not yet implemented. Use `lumen run "<prompt>"` for now.\n');
    return 1;
};
//# sourceMappingURL=chat.js.map