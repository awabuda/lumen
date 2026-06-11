/**
 * Telemetry — lightweight, anonymous usage counters.
 *
 * Telemetry is **opt-in** and **off by default**. When
 * enabled, the agent emits a single counter event per run
 * with these fields:
 *   - `run_count`: total number of agent runs
 *   - `tool_calls`: number of tool invocations in this run
 *   - `iterations`: number of agent loop iterations
 *   - `duration_ms`: wall-clock duration of the run
 *   - `provider_id`: the LLM provider used
 *   - `model`: the model identifier
 *
 * No prompt text, no tool arguments, no file paths, no
 * environment variables are ever collected.
 *
 * The default backend is a no-op. Operators who want
 * telemetry wire a {@link TelemetryBackend} at composition
 * time.
 */

/** A single telemetry event. */
export interface TelemetryEvent {
  readonly runCount: number
  readonly toolCalls: number
  readonly iterations: number
  readonly durationMs: number
  readonly providerId: string
  readonly model: string
  readonly timestamp: number
}

/** The contract every telemetry backend implements. */
export abstract class BaseTelemetryBackend {
  /** Stable identifier for the implementation. */
  public abstract readonly id: string

  /** Emit one event. */
  public abstract emit(event: TelemetryEvent): void

  /** Flush any buffered events. */
  public abstract flush(): Promise<void>
}

// ---------------------------------------------------------------------------
// NoopTelemetryBackend — the default
// ---------------------------------------------------------------------------

/** Default no-op backend. Does nothing. */
export class NoopTelemetryBackend extends BaseTelemetryBackend {
  public readonly id = 'noop'

  public emit(_event: TelemetryEvent): void {
    // no-op
  }

  public async flush(): Promise<void> {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// ConsoleTelemetryBackend — for debugging
// ---------------------------------------------------------------------------

/** Writes telemetry events to stderr as JSON lines. */
export class ConsoleTelemetryBackend extends BaseTelemetryBackend {
  public readonly id = 'console'

  public emit(event: TelemetryEvent): void {
    process.stderr.write(JSON.stringify(event) + '\n')
  }

  public async flush(): Promise<void> {
    // console is synchronous; nothing to flush.
  }
}

// ---------------------------------------------------------------------------
// Telemetry collector — the agent-facing surface
// ---------------------------------------------------------------------------

/**
 * The agent loop calls this after every run. It increments
 * the run counter and delegates to the backend.
 */
export class TelemetryCollector {
  private readonly backend: BaseTelemetryBackend
  private runCount = 0

  public constructor(backend: BaseTelemetryBackend = new NoopTelemetryBackend()) {
    this.backend = backend
  }

  /** Record a completed run. */
  public record(event: Omit<TelemetryEvent, 'runCount' | 'timestamp'>): void {
    this.runCount += 1
    this.backend.emit({
      ...event,
      runCount: this.runCount,
      timestamp: Date.now(),
    })
  }

  /** Flush buffered events. */
  public async flush(): Promise<void> {
    await this.backend.flush()
  }

  /** Current run count. */
  public get runs(): number {
    return this.runCount
  }
}
