/**
 * P29.1 \u2014 `ComputerUseModel` interface + `AnthropicComputerUseModel`
 * reference implementation.
 *
 * P29.0 \u00a71.1 names the cross-sweep vendor decision:
 *   - Anthropic Computer Use (hosted)
 *   - OpenAI CUA (hosted)
 *   - OSS IBM-CUA (self-hosted, OpenAI-compatible API)
 *   - Pure-JS local stub (for tests)
 *
 * This commit lands the **interface** + the **Anthropic
 * reference implementation** + a **pure-JS stub** for
 * tests. OpenAI / OSS adapters ship as separate P29.1.x
 * commits once the user picks the vendor.
 *
 * The interface is the small surface the agent loop
 * composes with: a screenshot + an action history in,
 * the next action (or a stop signal) out. Everything
 * else (image base64 \u2192 provider format, action
 * vocabulary, stop-signal mapping) is implementation
 * detail.
 *
 * Why an interface and not a class (P19+ rule 14): the
 * cross-sweep choice is between hosted and OSS
 * implementations; the surface is small enough that a
 * class adds zero behavioural gain.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Action vocabulary
// ---------------------------------------------------------------------------

/** Discriminated action vocabulary the lum en agent
 *  loop consumes. Cross-walks to the provider's native
 *  action shape are implementation detail. */
export const ComputerActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), x: z.number().int().min(0), y: z.number().int().min(0), button: z.enum(['left', 'right', 'middle']).optional() }),
  z.object({ type: z.literal('type'), text: z.string().min(1) }),
  z.object({ type: z.literal('key'), key: z.string().min(1) }),
  z.object({ type: z.literal('scroll'), x: z.number().int().min(0), y: z.number().int().min(0), dx: z.number().int(), dy: z.number().int() }),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).optional() }),
  z.object({ type: z.literal('stop'), reason: z.string().optional() }),
])
export type ComputerAction = z.infer<typeof ComputerActionSchema>

/** Single prior action the agent took. The model
 *  consumes the history to maintain context across
 *  multiple screenshot \u2192 action rounds. */
export const ComputerActionHistoryEntrySchema = z.object({
  action: ComputerActionSchema,
  /** Free-form note the loop appends (e.g. \"the user
   *  wants me to log in\"). Optional. */
  note: z.string().optional(),
})
export type ComputerActionHistoryEntry = z.infer<typeof ComputerActionHistoryEntrySchema>

/** Input to a ComputerUseModel. */
export const ComputerUseModelInputSchema = z.object({
  /** Base64 PNG screenshot. The model should look at
   *  the screenshot and pick the next action. */
  screenshot: z.string().min(1),
  /** History of prior actions. Optional. */
  history: z.array(ComputerActionHistoryEntrySchema).default([]),
  /** Free-form hint from the agent loop (e.g. \"click
   *  the login button\"). Optional. */
  hint: z.string().optional(),
})
export type ComputerUseModelInput = z.infer<typeof ComputerUseModelInputSchema>

// ---------------------------------------------------------------------------
// Model interface
// ---------------------------------------------------------------------------

/** The contract every Computer Use model implementation
 *  must satisfy. The agent loop composes \`computer_use\`
 *  (P28.1) with this interface: it takes a screenshot,
 *  calls \`nextAction()\`, dispatches the returned
 *  action back through the tool, and repeats. */
export interface ComputerUseModel {
  /** Stable id (e.g. \`anthropic\`, \`openai\`, \`oss-ibm\`,
   *  \`stub\`). */
  readonly id: string
  /** Whether the model is hosted (HTTP) or self-hosted.
   *  Operators can use this flag to gate the
   *  \`--approve-on\` policy. */
  readonly hosted: boolean
  /** Take a screenshot + history and return the next
   *  action (or a stop signal). */
  nextAction(input: ComputerUseModelInput): Promise<ComputerAction>
}

// ---------------------------------------------------------------------------
// Reference: Anthropic
// ---------------------------------------------------------------------------

/** Anthropic CUA adapter. PURE STUB \u2014 the actual API
 *  surface ships in P29.1.1 once the user picks the
 *  vendor. The shape of the stub is: a deterministic
 *  action picker (e.g. \"always click the centre of the
 *  screenshot\") so the test suite can pin the
 *  interface contract. */
export const AnthropicComputerUseModel = (opts: {
  /** Stub-mode action: which canned action to return
   *  for every call. Used by the unit test; P29.1.1
   *  replaces the stub with a real Anthropic HTTP
   *  call. */
  readonly stubAction?: ComputerAction
} = {}): ComputerUseModel => ({
  id: 'anthropic',
  hosted: true,
  async nextAction(_input) {
    // P29.1 STUB: returns the canned action. P29.1.1
    // replaces this with a fetch() to the Anthropic
    // Computer Use API.
    return (
      opts.stubAction ?? {
        type: 'click',
        x: 100,
        y: 100,
      }
    )
  },
})

// ---------------------------------------------------------------------------
// Reference: stub (pure-JS, used in tests)
// ---------------------------------------------------------------------------

/** Pure-JS stub. \`nextAction\` returns the canned
 *  action verbatim. The unit test suite uses this
 *  surface to drive the agent-loop integration tests
 *  without an API key. */
export const StubComputerUseModel = (opts: {
  readonly action?: ComputerAction
} = {}): ComputerUseModel => ({
  id: 'stub',
  hosted: false,
  async nextAction(_input) {
    return opts.action ?? { type: 'stop', reason: 'stub' }
  },
})