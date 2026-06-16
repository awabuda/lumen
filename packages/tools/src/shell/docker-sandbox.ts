/**
 * Docker sandbox — runs shell commands inside an ephemeral
 * Docker container.
 *
 * The sandbox uses `docker run` with these flags:
 *   - `--rm` — remove the container after the command exits.
 *   - `--network=none` — no outbound network.
 *   - `--read-only` — root filesystem is read-only.
 *   - `--tmpfs /tmp:exec` — writable /tmp.
 *   - `--cpus=1`, `--memory=256m`, `--pids-limit=64`.
 *   - `--security-opt=no-new-privileges`.
 *
 * All of these are configurable via {@link DockerSandboxConfig}.
 */

import { spawn } from 'node:child_process'
import type {
  ShellSandbox,
  ShellSandboxConfig,
  ShellSandboxOutcome,
  ShellSandboxRefusalReason,
  ShellSandboxRequest,
  ShellSandboxResult,
} from './sandbox.js'

/** Configuration for the Docker sandbox. */
export interface DockerSandboxConfig {
  /** Docker image. Defaults to `node:20-alpine`. */
  readonly image?: string
  /** Working directory inside the container. */
  readonly workdir?: string
  /** Additional `docker run` flags. */
  readonly extraFlags?: ReadonlyArray<string>
  /** Timeout in milliseconds. Defaults to 30_000. */
  readonly timeoutMs?: number
  /** Maximum output bytes before truncation. */
  readonly maxOutputBytes?: number
  /** Disable the `--network=none` flag. */
  readonly allowNetwork?: boolean
  /** CPU limit (`--cpus`). */
  readonly cpus?: number
  /** Memory limit (`--memory`). */
  readonly memory?: string
  /** PID limit (`--pids-limit`). */
  readonly pidsLimit?: number
}

const DEFAULTS: Required<DockerSandboxConfig> = {
  image: 'node:20-alpine',
  workdir: '/workspace',
  extraFlags: [],
  timeoutMs: 30_000,
  maxOutputBytes: 256 * 1024,
  allowNetwork: false,
  cpus: 1,
  memory: '256m',
  pidsLimit: 64,
}

/**
 * A {@link ShellSandbox} that runs commands inside an
 * ephemeral Docker container. The container is created and
 * destroyed for every invocation — stateless by design.
 */
export class DockerSandbox implements ShellSandbox {
  public readonly id = 'docker'
  private readonly config: Required<DockerSandboxConfig>

  public constructor(config: DockerSandboxConfig = {}) {
    this.config = { ...DEFAULTS, ...config }
  }

  public run(request: ShellSandboxRequest): Promise<ShellSandboxOutcome> {
    // Refuse empty commands.
    if (request.command.length === 0) {
      return Promise.resolve(this.refuse('policy-violation', 'Refusing to run an empty command'))
    }

    // Join argv into a single shell command string for `sh -c`.
    const cmd = request.command.join(' ')
    const args = this.buildArgs(cmd)

    return new Promise<ShellSandboxOutcome>((resolve) => {
      const child = spawn('docker', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: this.config.timeoutMs,
      })

      let stdout = ''
      let stderr = ''
      let killed = false

      const onStdout = (data: Buffer): void => {
        if (stdout.length < this.config.maxOutputBytes) {
          stdout += data.toString('utf-8')
        }
      }

      const onStderr = (data: Buffer): void => {
        if (stderr.length < this.config.maxOutputBytes) {
          stderr += data.toString('utf-8')
        }
      }

      child.stdout?.on('data', onStdout)
      child.stderr?.on('data', onStderr)

      const timer = setTimeout(() => {
        killed = true
        child.kill('SIGKILL')
      }, this.config.timeoutMs)

      child.on('close', (code, signal) => {
        clearTimeout(timer)
        child.stdout?.removeListener('data', onStdout)
        child.stderr?.removeListener('data', onStderr)

        const truncated =
          stdout.length >= this.config.maxOutputBytes || stderr.length >= this.config.maxOutputBytes

        if (killed || signal === 'SIGKILL') {
          resolve(
            this.refuse('budget-exhausted', `Command timed out after ${this.config.timeoutMs}ms`),
          )
          return
        }

        const result: ShellSandboxResult = {
          exitCode: code,
          signal: signal ?? null,
          stdout,
          stderr,
          durationMs: 0,
          truncated,
        }

        resolve({ kind: 'ok', result })
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        resolve(this.refuse('policy-disabled', `Docker is not available: ${err.message}`))
      })
    })
  }

  /**
   * Build the `docker run` argument list for a command.
   * Exposed as a public method so tests can inspect the
   * generated args without actually running Docker.
   */
  public buildArgs(command: string): string[] {
    const args: string[] = ['run', '--rm']

    // Security hardening.
    if (!this.config.allowNetwork) args.push('--network=none')
    args.push('--read-only')
    args.push('--tmpfs', '/tmp:exec')
    args.push('--security-opt=no-new-privileges')

    // Resource limits.
    args.push('--cpus', String(this.config.cpus))
    args.push('--memory', this.config.memory)
    args.push('--pids-limit', String(this.config.pidsLimit))

    // Working directory.
    args.push('-w', this.config.workdir)

    // Extra flags (operator-supplied).
    for (const flag of this.config.extraFlags) {
      args.push(flag)
    }

    // Image and command.
    args.push(this.config.image)
    args.push('sh', '-c', command)

    return args
  }

  private refuse(reason: ShellSandboxRefusalReason, message: string): ShellSandboxOutcome {
    return { kind: 'refused', reason, message }
  }
}

/**
 * Factory function that creates a {@link DockerSandbox}.
 * Pass this to {@link withSandboxFactory} to register the
 * Docker strategy in the sandbox registry.
 */
export const dockerSandboxFactory = (config?: DockerSandboxConfig): ShellSandbox =>
  new DockerSandbox(config)
