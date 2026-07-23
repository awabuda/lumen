/**
 * P25.7 — Permission Mode helpers (bug.md #53).
 *
 * Pins the enum + the resolution / bypass predicates.
 * The dispatch-time wiring (skip rule evaluation when
 * `mode === 'bypassPermissions'`) is a future agent-loop
 * ticket.
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PERMISSION_MODE,
  effectiveMode,
  modeBypassesRules,
  PermissionModeSchema,
} from '../src/agent/middleware/tool-permission.js'
import type { ToolPermissionPolicy } from '../src/agent/middleware/tool-permission.js'

const basePolicy = (overrides: Partial<ToolPermissionPolicy> = {}): ToolPermissionPolicy => ({
  version: 1,
  default: 'allow' as const,
  rules: [],
  imports: [],
  allowOverrides: false,
  ...overrides,
})

describe('P25.7 — PermissionModeSchema', () => {
  it('accepts the four canonical modes', () => {
    expect(PermissionModeSchema.parse('default')).toBe('default')
    expect(PermissionModeSchema.parse('acceptEdits')).toBe('acceptEdits')
    expect(PermissionModeSchema.parse('auto')).toBe('auto')
    expect(PermissionModeSchema.parse('bypassPermissions')).toBe('bypassPermissions')
  })

  it('rejects an unknown mode', () => {
    expect(PermissionModeSchema.safeParse('admin').success).toBe(false)
  })
})

describe('P25.7 — effectiveMode', () => {
  it('returns the policy\'s explicit mode', () => {
    expect(effectiveMode(basePolicy({ mode: 'auto' }))).toBe('auto')
    expect(effectiveMode(basePolicy({ mode: 'bypassPermissions' }))).toBe('bypassPermissions')
  })

  it('defaults to "default" when the policy omits the mode (back-compat)', () => {
    expect(effectiveMode(basePolicy())).toBe(DEFAULT_PERMISSION_MODE)
    expect(DEFAULT_PERMISSION_MODE).toBe('default')
  })
})

describe('P25.7 — modeBypassesRules', () => {
  it('returns true ONLY for bypassPermissions', () => {
    expect(modeBypassesRules('bypassPermissions')).toBe(true)
    expect(modeBypassesRules('default')).toBe(false)
    expect(modeBypassesRules('acceptEdits')).toBe(false)
    expect(modeBypassesRules('auto')).toBe(false)
  })
})