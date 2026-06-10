/**
 * Tests for profile switching.
 *
 * Profiles can be declared either via a `profiles:` key in the user
 * or project config, or as sibling files next to the base config.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadConfigWithProfile,
  listProfiles,
  resolveProfile,
  DEFAULT_PROFILE,
} from '../src/index.js'
import { ConfigValidationError } from '../src/errors.js'

describe('resolveProfile', () => {
  it('returns DEFAULT_PROFILE when no hint is given', () => {
    expect(resolveProfile({})).toBe(DEFAULT_PROFILE)
  })

  it('honors an explicit profile option (highest priority)', () => {
    expect(resolveProfile({ profile: 'work' })).toBe('work')
  })

  it('treats profile: null as "force default"', () => {
    expect(resolveProfile({ profile: null })).toBe(DEFAULT_PROFILE)
  })

  it('reads LUMEN_PROFILE from the environment when no explicit hint is given', () => {
    const original = process.env['LUMEN_PROFILE']
    process.env['LUMEN_PROFILE'] = 'envprof'
    try {
      expect(resolveProfile({})).toBe('envprof')
    } finally {
      if (original === undefined) delete process.env['LUMEN_PROFILE']
      else process.env['LUMEN_PROFILE'] = original
    }
  })

  it('reads defaultProfile from the user config root', () => {
    expect(
      resolveProfile({ userConfigRoot: { defaultProfile: 'userprof' } }),
    ).toBe('userprof')
  })

  it('falls back to the project config root', () => {
    expect(
      resolveProfile({ projectConfigRoot: { defaultProfile: 'projprof' } }),
    ).toBe('projprof')
  })

  it('explicit profile wins over env and defaultProfile', () => {
    const original = process.env['LUMEN_PROFILE']
    process.env['LUMEN_PROFILE'] = 'envprof'
    try {
      expect(
        resolveProfile({
          profile: 'explicit',
          userConfigRoot: { defaultProfile: 'userprof' },
        }),
      ).toBe('explicit')
    } finally {
      if (original === undefined) delete process.env['LUMEN_PROFILE']
      else process.env['LUMEN_PROFILE'] = original
    }
  })
})

describe('loadConfigWithProfile', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumen-config-profile-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the base config + profile="default" when no profile is set', async () => {
    const projectPath = join(dir, 'config.yaml')
    writeFileSync(
      projectPath,
      [
        'defaultModel: base-model',
        'profiles:',
        '  work:',
        '    defaultModel: work-model',
        '',
      ].join('\n'),
      'utf8',
    )
    const cfg = await loadConfigWithProfile({
      projectPath,
      skipUserConfig: true,
      skipProjectConfig: false,
    })
    expect(cfg.defaultModel).toBe('base-model')
    expect(cfg.profile).toBe(DEFAULT_PROFILE)
  })

  it('overlays a profile from `profiles:` on top of the base config', async () => {
    const projectPath = join(dir, 'config.yaml')
    writeFileSync(
      projectPath,
      [
        'defaultModel: base-model',
        'profiles:',
        '  work:',
        '    defaultModel: work-model',
        '  personal:',
        '    defaultModel: personal-model',
        '',
      ].join('\n'),
      'utf8',
    )
    const cfg = await loadConfigWithProfile({
      projectPath,
      skipUserConfig: true,
      skipProjectConfig: false,
      profile: 'work',
    })
    expect(cfg.defaultModel).toBe('work-model')
    expect(cfg.profile).toBe('work')
  })

  it('reads a sibling <base>.<profile>.yaml file', async () => {
    const projectPath = join(dir, 'config.yaml')
    writeFileSync(projectPath, 'defaultModel: base-model\n', 'utf8')
    writeFileSync(
      join(dir, 'config.staging.yaml'),
      'defaultModel: staging-model\n',
      'utf8',
    )
    const cfg = await loadConfigWithProfile({
      projectPath,
      skipUserConfig: true,
      skipProjectConfig: false,
      profile: 'staging',
    })
    expect(cfg.defaultModel).toBe('staging-model')
    expect(cfg.profile).toBe('staging')
  })

  it('throws ConfigValidationError when the resolved profile does not exist', async () => {
    const projectPath = join(dir, 'config.yaml')
    writeFileSync(projectPath, 'defaultModel: base-model\n', 'utf8')
    await expect(
      loadConfigWithProfile({
        projectPath,
        skipUserConfig: true,
        skipProjectConfig: false,
        profile: 'does-not-exist',
      }),
    ).rejects.toBeInstanceOf(ConfigValidationError)
  })

  it('throws when the merged profile+base fails schema validation', async () => {
    const projectPath = join(dir, 'config.yaml')
    writeFileSync(projectPath, 'defaultModel: base-model\n', 'utf8')
    // `logging.level: bogus` is invalid against the enum.
    writeFileSync(
      join(dir, 'config.bad.yaml'),
      'logging:\n  level: bogus\n',
      'utf8',
    )
    await expect(
      loadConfigWithProfile({
        projectPath,
        skipUserConfig: true,
        skipProjectConfig: false,
        profile: 'bad',
      }),
    ).rejects.toBeInstanceOf(ConfigValidationError)
  })
})

describe('listProfiles', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumen-config-list-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns ["default"] when no profiles are declared', () => {
    const out = listProfiles({
      projectPath: join(dir, 'config.yaml'),
      userPath: join(dir, 'user-config.yaml'),
      skipUserConfig: true,
      skipProjectConfig: false,
    })
    expect(out).toContain(DEFAULT_PROFILE)
  })

  it('lists profiles declared in `profiles:`', () => {
    const projectPath = join(dir, 'config.yaml')
    writeFileSync(
      projectPath,
      ['profiles:', '  work: {}', '  personal: {}', ''].join('\n'),
      'utf8',
    )
    const out = listProfiles({
      projectPath,
      skipUserConfig: true,
      skipProjectConfig: false,
    })
    expect(out).toEqual(expect.arrayContaining([DEFAULT_PROFILE, 'work', 'personal']))
  })
})
