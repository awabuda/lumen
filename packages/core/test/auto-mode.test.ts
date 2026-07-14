/** P22.5 — auto-mode classifier + middleware tests. */

import { describe, expect, it } from 'vitest'
import {
  AutoModeRulesSchema,
  DEFAULT_RISK_TABLE,
  type ToolCall,
  createAutoModeMiddleware,
  createHeuristicRiskClassifier,
} from '../src/index.js'

const toolCall = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: 't1',
  name,
  arguments: args,
})

const enabledRules = (overrides: Record<string, unknown> = {}) =>
  AutoModeRulesSchema.parse({ enabled: true, ...overrides })

describe('AutoModeRulesSchema', () => {
  it('defaults the optional lists to empty arrays', () => {
    const parsed = AutoModeRulesSchema.parse({ enabled: true })
    expect(parsed.neverAllowTools).toEqual([])
    expect(parsed.hardDenyPatterns).toEqual([])
    expect(parsed.allowPatterns).toEqual([])
    expect(parsed.softDenyPatterns).toEqual([])
  })

  it('rejects an unknown top-level key (strict)', () => {
    const result = AutoModeRulesSchema.safeParse({ enabled: true, surprise: 1 })
    expect(result.success).toBe(false)
  })
})

describe('DEFAULT_RISK_TABLE', () => {
  it('classifies the four core tools by default tier', () => {
    expect(DEFAULT_RISK_TABLE.read_file).toBe('low')
    expect(DEFAULT_RISK_TABLE.list_dir).toBe('low')
    expect(DEFAULT_RISK_TABLE.search_files).toBe('low')
    expect(DEFAULT_RISK_TABLE.write_file).toBe('medium')
    expect(DEFAULT_RISK_TABLE.terminal).toBe('high')
  })
})

describe('createHeuristicRiskClassifier', () => {
  it('returns ask for every call when enabled is false', () => {
    const c = createHeuristicRiskClassifier({ rules: { enabled: false } })
    expect(c.id).toBe('heuristic')
    expect(c.classify(toolCall('read_file'))).toBe('ask')
    expect(c.classify(toolCall('terminal'))).toBe('ask')
  })

  it('returns allow for low-risk tools when enabled', () => {
    const c = createHeuristicRiskClassifier({ rules: enabledRules() })
    expect(c.classify(toolCall('read_file'))).toBe('allow')
    expect(c.tier(toolCall('read_file'))).toBe('low')
  })

  it('returns ask for high-risk tools even when enabled', () => {
    const c = createHeuristicRiskClassifier({ rules: enabledRules() })
    expect(c.classify(toolCall('terminal'))).toBe('ask')
    expect(c.tier(toolCall('terminal'))).toBe('high')
  })

  it('returns ask for tools not in the table (unknown tier)', () => {
    const c = createHeuristicRiskClassifier({ rules: enabledRules() })
    expect(c.classify(toolCall('mystery_tool'))).toBe('ask')
    expect(c.tier(toolCall('mystery_tool'))).toBe('unknown')
  })

  it('honours neverAllowTools even for low-risk tools', () => {
    const c = createHeuristicRiskClassifier({
      rules: enabledRules({ neverAllowTools: ['read_file'] }),
    })
    expect(c.classify(toolCall('read_file'))).toBe('ask')
    // Other low tools are still allowed.
    expect(c.classify(toolCall('list_dir'))).toBe('allow')
  })

  it('hardDenyPatterns flips the decision to deny', () => {
    const c = createHeuristicRiskClassifier({
      rules: enabledRules({ hardDenyPatterns: ['^terminal$'] }),
    })
    expect(c.classify(toolCall('terminal'))).toBe('deny')
    // Other tools unchanged.
    expect(c.classify(toolCall('read_file'))).toBe('allow')
  })

  it('skips a malformed regex in hardDenyPatterns rather than crashing', () => {
    const c = createHeuristicRiskClassifier({
      rules: enabledRules({ hardDenyPatterns: ['(unclosed'] }),
    })
    // The malformed regex is skipped, so the tier wins.
    expect(c.classify(toolCall('read_file'))).toBe('allow')
    expect(c.classify(toolCall('terminal'))).toBe('ask')
  })

  it('risk table override merges on top of the default', () => {
    const c = createHeuristicRiskClassifier({
      rules: enabledRules(),
      riskTable: { terminal: 'low' },
    })
    expect(c.tier(toolCall('terminal'))).toBe('low')
    expect(c.classify(toolCall('terminal'))).toBe('allow')
  })
})

describe('createAutoModeMiddleware', () => {
  it('lets allow dispatch without aborting', async () => {
    const c = createHeuristicRiskClassifier({ rules: enabledRules() })
    const mw = createAutoModeMiddleware({ classifier: c })
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const defaultCall = async () => {
      calls.push({ name: 'inner', args: {} })
      return 'result'
    }
    const result = await mw.wrapToolCall!(toolCall('read_file') as never, defaultCall as never)
    expect(result).toBe('result')
    expect(calls).toHaveLength(1)
  })

  it('throws AbortError on deny', async () => {
    const c = createHeuristicRiskClassifier({
      rules: enabledRules({ hardDenyPatterns: ['terminal'] }),
    })
    const mw = createAutoModeMiddleware({ classifier: c })
    await expect(
      mw.wrapToolCall!(toolCall('terminal') as never, (async () => 'unused') as never),
    ).rejects.toThrow(/auto-mode denied: tool "terminal"/)
  })

  it('falls through to the default call on ask', async () => {
    const c = createHeuristicRiskClassifier({ rules: { enabled: false } })
    const mw = createAutoModeMiddleware({ classifier: c })
    const defaultCall = async () => 'default'
    const result = await mw.wrapToolCall!(toolCall('read_file') as never, defaultCall as never)
    expect(result).toBe('default')
  })
})

describe('auto-mode + default-call coexistence (P22.5.1)', () => {
  it('chains auto-mode allow → defaultCall → result (short-circuit path)', async () => {
    const c = createHeuristicRiskClassifier({ rules: enabledRules() })
    const mw = createAutoModeMiddleware({ classifier: c })
    let innerCalled = false
    const defaultCall = async () => {
      innerCalled = true
      return 'inner-result'
    }
    const result = await mw.wrapToolCall!(toolCall('read_file') as never, defaultCall as never)
    expect(result).toBe('inner-result')
    expect(innerCalled).toBe(true)
  })
})

describe('static policy autoMode block (P22.5.2)', () => {
  it('accepts an omitted autoMode block', async () => {
    const { ToolPermissionPolicySchema } = await import('../src/index.js')
    const result = ToolPermissionPolicySchema.safeParse({
      version: 1,
      default: 'ask',
      rules: [],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.autoMode).toBeUndefined()
    }
  })

  it('accepts a fully-populated autoMode block', async () => {
    const { ToolPermissionPolicySchema } = await import('../src/index.js')
    const result = ToolPermissionPolicySchema.safeParse({
      version: 1,
      default: 'ask',
      rules: [],
      autoMode: {
        enabled: true,
        neverAllowTools: ['read_file'],
        hardDenyPatterns: ['^terminal$'],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.autoMode?.enabled).toBe(true)
      expect(result.data.autoMode?.neverAllowTools).toEqual(['read_file'])
    }
  })

  it('rejects a malformed autoMode block (missing enabled)', async () => {
    const { ToolPermissionPolicySchema } = await import('../src/index.js')
    const result = ToolPermissionPolicySchema.safeParse({
      version: 1,
      default: 'ask',
      rules: [],
      autoMode: {
        neverAllowTools: ['read_file'],
      },
    })
    expect(result.success).toBe(false)
  })
})
