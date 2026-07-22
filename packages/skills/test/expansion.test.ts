/**
 * P23.11 — skill template expansion (fix #67).
 *
 *   #67  Skill instructions were previously fixed strings; the
 *        prompt could not pass runtime arguments through (e.g.
 *        `/code-review <branch>`). `expandTemplate` /
 *        `expandInstructions` / `expandFromContext` walk an
 *        instruction fragment array and substitute `$ARGUMENTS`
 *        and named placeholders (`$NAME` / `${NAME}`).
 */

import { describe, expect, it } from 'vitest'

import { expandFromContext, expandInstructions, expandTemplate } from '../src/expansion.js'

describe('P23.11 — fix #67: skill template expansion', () => {
  it('replaces $ARGUMENTS with the joined argument list', () => {
    const out = expandTemplate('review $ARGUMENTS', {
      arguments: ['main', '--strict'],
    })
    expect(out).toBe('review main --strict')
  })

  it('replaces $ARGUMENTS with an empty string when no arguments are passed', () => {
    expect(expandTemplate('cost so far: $ARGUMENTS')).toBe('cost so far: ')
  })

  it('replaces named placeholders ($NAME and ${NAME})', () => {
    const out = expandTemplate('user=$USER dir=$DIR literal=${USER}', {
      named: { USER: 'alice', DIR: '/tmp' },
    })
    expect(out).toBe('user=alice dir=/tmp literal=alice')
  })

  it('leaves unknown named placeholders untouched', () => {
    expect(expandTemplate('hello $WHO', { named: { FOO: 'bar' } })).toBe('hello $WHO')
  })

  it('mixed $ARGUMENTS + named', () => {
    const out = expandTemplate('$CMD on $HOST with $ARGUMENTS', {
      arguments: ['--verbose', '--dry-run'],
      named: { CMD: 'audit', HOST: 'prod-eu' },
    })
    expect(out).toBe('audit on prod-eu with --verbose --dry-run')
  })

  it('expandInstructions maps over a fragment array', () => {
    const out = expandInstructions(['review $ARGUMENTS', 'against $BASE'], {
      arguments: ['main'],
      named: { BASE: 'origin/main' },
    })
    expect(out).toEqual(['review main', 'against origin/main'])
  })

  it('expandFromContext returns the original fragments when metadata is empty', () => {
    const original = ['review $ARGUMENTS']
    expect(expandFromContext(original, {})).toBe(original)
  })

  it('expandFromContext extracts arguments / named from metadata', () => {
    const out = expandFromContext(['review $ARGUMENTS against $BASE'], {
      metadata: {
        arguments: ['feature-x'],
        named: { BASE: 'main' },
      },
    })
    expect(out).toEqual(['review feature-x against main'])
  })
})
