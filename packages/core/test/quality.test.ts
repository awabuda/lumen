import { describe, expect, it } from 'vitest'
import {
  type QualityScores,
  planCoverageScore,
  reflectionConfidenceScore,
  subagentCoordinationScore,
} from '../src/bench/quality.js'

describe('planCoverageScore', () => {
  it('returns 0 for an empty goal or empty plan', () => {
    expect(planCoverageScore('', [{ description: 'something' }])).toBe(0)
    expect(planCoverageScore('a goal', [])).toBe(0)
  })

  it('returns 1 when every goal token appears in the steps', () => {
    const score = planCoverageScore('write tests', [
      { description: 'write the unit tests' },
    ])
    expect(score).toBe(1)
  })

  it('returns a fractional score for partial coverage', () => {
    const score = planCoverageScore('write tests and commit', [
      { description: 'write' },
    ])
    // 1 of 4 tokens → 0.25
    expect(score).toBe(0.25)
  })
})

describe('reflectionConfidenceScore', () => {
  it('parses a [confidence: 0.XX] suffix', () => {
    expect(reflectionConfidenceScore('done [confidence: 0.73]')).toBe(0.73)
  })

  it('clamps out-of-range values', () => {
    expect(reflectionConfidenceScore('done [confidence: 1.5]')).toBe(1)
    expect(reflectionConfidenceScore('done [confidence: -0.5]')).toBe(0)
  })

  it('falls back to a length-weighted heuristic when no suffix is present', () => {
    const short = reflectionConfidenceScore('hi')
    const long = reflectionConfidenceScore('this is a longer string with more tokens')
    expect(short).toBeGreaterThanOrEqual(0)
    expect(long).toBeGreaterThan(short)
  })
})

describe('subagentCoordinationScore', () => {
  it('returns 0 for an empty result list', () => {
    expect(subagentCoordinationScore([])).toBe(0)
  })

  it('returns 1 when every result has non-empty content', () => {
    expect(
      subagentCoordinationScore([
        { finalMessage: { content: 'a' } },
        { finalMessage: { content: 'b' } },
      ]),
    ).toBe(1)
  })

  it('decreases linearly with empty results', () => {
    expect(
      subagentCoordinationScore([
        { finalMessage: { content: 'a' } },
        { finalMessage: { content: '' } },
      ]),
    ).toBe(0.5)
  })

  it('treats missing content as empty', () => {
    expect(
      subagentCoordinationScore([
        { finalMessage: {} },
        { finalMessage: { content: 'a' } },
      ]),
    ).toBe(0.5)
  })
})

describe('QualityScores aggregation', () => {
  it('the three scores compose into a 0-1 triple', () => {
    const triple: QualityScores = {
      planCoverage: 0.8,
      reflectionConfidence: 0.6,
      subagentCoordination: 1,
    }
    expect(triple.planCoverage + triple.reflectionConfidence + triple.subagentCoordination).toBeCloseTo(2.4, 4)
  })
})
