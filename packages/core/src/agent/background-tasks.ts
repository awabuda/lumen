/**
 * P25.3 \u2014 Background Task registry (bug.md #49).
 *
 * Long-running async tasks the agent can spawn and later
 * await. Pre-P25.3 the agent loop had no equivalent: a
 * sub-agent that kicked off a long `terminal.run` would
 * block the parent until completion.
 *
 * Why a helper function (P19+ rule 15) and not an
 * abstract `BaseBackgroundTask`: the registry is a thin
 * wrapper over a `Map<string, Promise<T>>` plus a
 * `Map<string, BackgroundTaskStatus>`. A class adds zero
 * behavioural gain.
 */

export type BackgroundTaskStatus =
  /** Promise is still pending. */
  | 'pending'
  /** Promise resolved with a value. */
  | 'resolved'
  /** Promise rejected with an error. */
  | 'rejected'
  /** Promise was cancelled via `cancel()`. */
  | 'cancelled'

export interface BackgroundTaskRecord<T> {
  /** Stable id (UUID v4). */
  readonly id: string
  /** Free-form label the operator can use to recognise
   *  the task in `lumen view` (P25.4). */
  readonly label: string
  /** Wall-clock ms of task start. */
  readonly startedAtMs: number
  /** Optional wall-clock ms of completion. */
  readonly finishedAtMs?: number
  /** Current status. */
  readonly status: BackgroundTaskStatus
  /** Resolved value, if status === 'resolved'. */
  readonly value?: T
  /** Rejected error, if status === 'rejected'. */
  readonly error?: Error
}

/**
 * In-memory registry. The composition root owns one
 * instance per agent run; tests can spin up an isolated
 * instance for hermetic runs.
 */
export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, BackgroundTaskRecord<unknown>>()
  private readonly promises = new Map<string, Promise<unknown>>()

  /** Spawn a new background task. Returns the record
   *  synchronously; the promise runs in the background. */
  public spawn<T>(params: {
    readonly id: string
    readonly label: string
    readonly run: () => Promise<T>
  }): BackgroundTaskRecord<T> {
    const startedAtMs = Date.now()
    const promise: Promise<T> = params.run()
    // Defensive copy: callers should not see the inner
    // `unknown` view.
    const record: BackgroundTaskRecord<T> = {
      id: params.id,
      label: params.label,
      startedAtMs,
      status: 'pending',
    }
    this.tasks.set(params.id, record as BackgroundTaskRecord<unknown>)
    this.promises.set(params.id, promise)
    promise.then(
      (value) => {
        this.tasks.set(params.id, {
          id: params.id,
          label: params.label,
          startedAtMs,
          finishedAtMs: Date.now(),
          status: 'resolved',
          value,
        })
      },
      (err) => {
        this.tasks.set(params.id, {
          id: params.id,
          label: params.label,
          startedAtMs,
          finishedAtMs: Date.now(),
          status: 'rejected',
          error: err instanceof Error ? err : new Error(String(err)),
        })
      },
    )
    return record
  }

  /** Lookup by id. */
  public get<T>(id: string): BackgroundTaskRecord<T> | undefined {
    return this.tasks.get(id) as BackgroundTaskRecord<T> | undefined
  }

  /** All tasks, sorted by startedAtMs ascending. */
  public list(): ReadonlyArray<BackgroundTaskRecord<unknown>> {
    return [...this.tasks.values()].sort((a, b) => a.startedAtMs - b.startedAtMs)
  }

  /** `await` a previously-spawned task. Throws if the id
   *  is unknown. */
  public async await<T>(id: string): Promise<T> {
    const promise = this.promises.get(id) as Promise<T> | undefined
    if (promise === undefined) {
      throw new Error(`BackgroundTaskRegistry.await: unknown task id "${id}"`)
    }
    return promise
  }

  /** Cancel a pending task. The promise is *not* aborted
   *  (we don't hold an AbortController); the record is
   *  marked 'cancelled' so `lumen view` (P25.4) renders
   *  it correctly. Once a promise resolves, cancel is a
   *  no-op. */
  public cancel(id: string): void {
    const cur = this.tasks.get(id)
    if (cur === undefined) return
    if (cur.status !== 'pending') return
    this.tasks.set(id, {
      ...cur,
      status: 'cancelled',
      finishedAtMs: Date.now(),
    })
  }
}