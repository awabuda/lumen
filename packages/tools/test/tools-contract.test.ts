/**
 * Wires {@link runToolContractTests} against every concrete
 * tool shipped by `@lumen/tools`. The wrapper is its own file
 * so the per-tool test files (which focus on side-effects and
 * the network/shell round-trip) stay focused.
 *
 * If you add a new tool, add another `runXxxToolContractTests`
 * block here — no other change is required.
 */

import {
  DateTool,
  EnvTool,
  GhTool,
  GitTool,
  ListDirTool,
  PatchTool,
  ReadFileTool,
  SearchFilesTool,
  TerminalTool,
  WhoamiTool,
  WriteFileTool,
} from '../src/index.js'
import { runToolContractTests } from './contract-suite.js'

runToolContractTests('ReadFileTool', () => new ReadFileTool())
runToolContractTests('WriteFileTool', () => new WriteFileTool())
runToolContractTests('PatchTool', () => new PatchTool())
runToolContractTests('ListDirTool', () => new ListDirTool())
runToolContractTests('SearchFilesTool', () => new SearchFilesTool())
runToolContractTests('TerminalTool', () => new TerminalTool())
runToolContractTests('GitTool', () => new GitTool())
runToolContractTests('DateTool', () => new DateTool())
runToolContractTests('EnvTool', () => new EnvTool())
runToolContractTests('WhoamiTool', () => new WhoamiTool())
runToolContractTests('GhTool', () => new GhTool())
