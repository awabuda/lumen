/**
 * P31.2 — Layered prompt sections + {@link PromptAssembler}.
 *
 * Mirrors §1.0 / §1.2 of `docs/P31-SYSTEM-PROMPT-DESIGN.md`:
 * a system prompt is built bottom-up from one of eight named
 * sections (K0 Kernel, P1 Project, P2 Persona, G1 Guidance,
 * G2 Skills index, B1 Bootstrap, MEMORY.md snapshot, D1
 * Runtime, D2 Turn inject). The assembler produces a single
 * string with the cache-boundary marker between the stable
 * prefix and the dynamic suffix; the primitive for the split
 * lives in `system-prompt-boundary.ts`.
 *
 * The default `KERNEL_TEXT` is intentionally short — the
 * design doc's §1.3 R4 + §1.10 split is "descriptive vs
 * policy"; every hard limit belongs in ToolRisk /
 * permission middleware, not in prose.
 */

import {
  appendDynamic,
  ensureSystemPromptCacheBoundary,
  joinWithBoundary,
  splitByBoundary,
  stripBoundary,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from './system-prompt-boundary.js'

/**
 * Hard-coded Kernel layer (K0). This is the *only* layer
 * that ships with `@lumen/core` — every other layer is a
 * profile / cwd walk-up decision. The text is descriptive;
 * ToolRisk + permission middleware enforce the workspace
 * boundary + dangerous-approval contract.
 *
 * Operators wanting to override the *identity* sentence
 * (not the safety contract) should pass `systemPrompt`
 * via `AgentConfig`, which is consumed as a Kernel
 * identity override per design doc §1.3 R4. Stripping the
 * contract requires an explicit `profile: 'bare'` test
 * mode.
 */
export const KERNEL_TEXT = [
  'You are Lumen, a coding and research agent.',
  'Workspace boundary: operate inside the user-supplied workspace only; out-of-workspace paths must be re-confirmed via approval.',
  'High-risk tools (terminal, write_file, network) require explicit approval by default.',
  'Where runtime registry / ToolRisk / permission policy disagree with this prompt, the runtime rules win — this text is descriptive guidance, not enforcement.',
].join('\n')

/**
 * Tooling guidance (G1) default template. Pre-P31 anti-
 * patterns serialised the tool schema into the prompt;
 * the design doc §1.3 R1 forbids that. We ship a short
 * prose template that names a few common tools without
 * their JSON shape; operators can override via the
 * TOOLS.md walk-up loader (P31.3).
 */
export const DEFAULT_GUIDANCE_TEXT = [
  'Tooling guidance:',
  '- Use the lowest-privilege tool that satisfies the task; read-only before write.',
  '- Prefer surgical actions over bulk operations; explain intent before each tool call.',
  '- Final answers should state the outcome directly; cite file paths the operator can verify.',
  '- The runtime tool registry is authoritative — if a tool is missing from this prompt, do not assume it is unavailable; check the live request.tools payload.',
].join('\n')

/**
 * Section identifiers used to gate per-layer profile
 * options. Mirrors §1.2 and the G2 / B1 / M1 opt-in
 * rows of design doc §1.7.
 */
export type SectionId =
  | 'kernel'
  | 'project'
  | 'persona'
  | 'guidance'
  | 'skillsIndex'
  | 'bootstrap'
  | 'memorySnapshot'

export interface SectionPayload {
  readonly id: SectionId
  /** The rendered prose for the section. Empty strings are dropped. */
  readonly text: string
}

export interface ProfileLayers {
  readonly persona?: boolean
  readonly bootstrap?: boolean
  readonly memorySnapshot?: boolean
  /** When true, the skills index is rendered with name+description (G2). */
  readonly skillsIndex?: boolean
}

/**
 * Runtime inputs that vary per turn and **must** stay in
 * the dynamic suffix (D1). Per design doc §1.3 R2, these
 * never reach the stable prefix.
 */
export interface DynamicRuntimeInputs {
  readonly sessionId: string
  readonly cwd: string
  readonly model: string
  readonly capturedAtIso: string
  readonly gitStatusLine?: string
}

/**
 * Per-layer content handed to the assembler. Profile-gated
 * sections are absent (undefined) when the profile has them
 * off; the assembler omits them entirely (no empty heading).
 */
export interface SectionContext {
  readonly profile: ProfileLayers
  readonly kernelIdentityOverride?: string
  readonly projectText?: string
  readonly personaText?: string
  readonly guidanceText?: string
  readonly skillsIndexText?: string
  readonly bootstrapText?: string
  readonly memorySnapshotText?: string
  readonly runtime: DynamicRuntimeInputs
  readonly middlewareDynamicChunks?: ReadonlyArray<string>
}

/**
 * What the assembler produces. The `cacheBoundary` field
 * is the marker literal — exposed for callers that need to
 * inspect the boundary (e.g. Anthropic cache-control hits,
 * see P31.5).
 */
export interface AssembledPrompt {
  readonly stable: string
  readonly dynamic: string
  readonly full: string
  readonly cacheBoundary: string
}

/**
 * Per-layer maxChars budget per design doc §1.7. Operators
 * can override via {@link PromptAssemblerOptions.budgetOverride};
 * the override is per-layer, deep-merged on top of these
 * defaults.
 */
export const DEFAULT_BUDGET = Object.freeze({
  kernel: 1_500,
  project: 12_000,
  persona: 8_000,
  guidance: 4_000,
  skillsIndex: 3_000,
  bootstrap: 4_000,
  memorySnapshot: 6_000,
  /** D1 runtime — design doc caps git status at 800 chars. */
  runtime: 2_000,
  /** D2 turn-inject — middleware pieces compete for this. */
  turnInject: 8_000,
})

export type LayerBudgets = Partial<typeof DEFAULT_BUDGET>

export interface PromptAssemblerOptions {
  readonly budgetOverride?: LayerBudgets
}

/**
 * Truncate `text` to `maxChars` chars; append the literal
 * marker ` …[truncated]` (3 unicode chars + literal) so an
 * LLM can tell the section was elided. The marker is in
 * prose — never in a JSON shape, never in a system-prompt
 * tag. Hard-coded short string keeps the helper LLM-readable
 * regardless of locale.
 */
export const truncateSection = (text: string, maxChars: number): string => {
  if (maxChars <= 0 || text.length <= maxChars) return text
  const head = text.slice(0, maxChars)
  return `${head}\n…[truncated]`
}

/**
 * Render the G2 skills index. The index lists `name +
 * description` for every discovered skill; when the result
 * would overflow `maxChars`, only the names are kept so
 * the LLM still has a discoverable list.
 */
export const renderSkillsIndex = (
  skills: ReadonlyArray<{ readonly name: string; readonly description: string }>,
  maxChars: number,
): string => {
  if (skills.length === 0) return ''
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`)
  const full = lines.join('\n')
  if (full.length <= maxChars) return full
  const namesOnly = skills.map((s) => `- ${s.name}`).join('\n')
  if (namesOnly.length <= maxChars) return namesOnly
  return truncateSection(namesOnly, maxChars)
}

/**
 * Truncate a single git-status line to `maxChars`. The
 * heuristic just trims overflow chars — git status lines
 * rarely exceed 200 chars even on huge repos; the budget
 * headroom is there so this stays a single-line fix.
 */
const truncateGitStatus = (line: string | undefined, maxChars: number): string => {
  if (line === undefined) return ''
  return truncateSection(line, maxChars)
}

export const DEFAULT_PROJECT_TEXT = ''

/**
 * Render the runtime block (D1) per §1.2 + §1.7. This block
 * always renders (Dynamic is REQUIRED per design doc §1.7)
 * even when every input field is empty — that way the
 * boundary invariant is upheld.
 */
export const renderRuntimeBlock = (
  inputs: DynamicRuntimeInputs,
  budget: LayerBudgets,
): string => {
  const dynBudget = budget.runtime ?? DEFAULT_BUDGET.runtime
  const gitBudget = Math.min(800, Math.floor(dynBudget / 4))
  const lines = [
    `session_id: ${inputs.sessionId}`,
    `cwd: ${inputs.cwd}`,
    `model: ${inputs.model}`,
    `captured_at: ${inputs.capturedAtIso}`,
    truncateGitStatus(inputs.gitStatusLine, gitBudget),
  ].filter((l) => l.length > 0)
  return truncateSection(lines.join('\n'), dynBudget)
}

/**
 * Produce one stable section payload per §1.2 layer rules.
 * Layer IDs are skipped entirely when the profile does not
 * enable them (P2 / B1 / G2 / M1) or when the relevant input
 * is absent (P1 has no file, default Persona is empty, …).
 */
export const collectStableSections = (
  ctx: SectionContext,
): ReadonlyArray<SectionPayload> => {
  const sections: SectionPayload[] = []
  // K0 — Kernel. Required. Identity may be overridden via
  // `kernelIdentityOverride` (AgentConfig.systemPrompt).
  // Per design doc §1.3 R4 the safety contract is part of
  // K0's *semantic* lock — overrides can swap the
  // identity sentence but must keep the safety contract
  // section. We model this by concatenating the override
  // identity sentence with the canonical contract lines
  // from `KERNEL_TEXT` (everything after the first line).
  let kernelBody: string
  if (ctx.kernelIdentityOverride !== undefined && ctx.kernelIdentityOverride.length > 0) {
    const lines = KERNEL_TEXT.split('\n')
    const safetyContract = lines.slice(1).join('\n')
    kernelBody = `${ctx.kernelIdentityOverride}\n${safetyContract}`
  } else {
    kernelBody = KERNEL_TEXT
  }
  sections.push({ id: 'kernel', text: kernelBody })
  // P1 — Project (cwd walk-up). Optional in practice
  // (skip when no AGENTS.md / CLAUDE.md found) but the
  // section identifier is registered; P31.3 fills it.
  if (ctx.projectText !== undefined && ctx.projectText.length > 0) {
    sections.push({ id: 'project', text: ctx.projectText })
  }
  // P2 — Persona. Profile-gated.
  if (ctx.profile.persona === true && ctx.personaText !== undefined && ctx.personaText.length > 0) {
    sections.push({ id: 'persona', text: ctx.personaText })
  }
  // G1 — Guidance. Recommended default; if `guidanceText`
  // is undefined or empty we fall back to the bundled
  // template rather than emit a blank heading.
  if (ctx.guidanceText !== undefined && ctx.guidanceText.length > 0) {
    sections.push({ id: 'guidance', text: ctx.guidanceText })
  } else {
    sections.push({ id: 'guidance', text: DEFAULT_GUIDANCE_TEXT })
  }
  // G2 — Skills index. Profile-gated.
  if (ctx.profile.skillsIndex === true && ctx.skillsIndexText !== undefined && ctx.skillsIndexText.length > 0) {
    sections.push({ id: 'skillsIndex', text: ctx.skillsIndexText })
  }
  // B1 — Bootstrap. Profile-gated.
  if (ctx.profile.bootstrap === true && ctx.bootstrapText !== undefined && ctx.bootstrapText.length > 0) {
    sections.push({ id: 'bootstrap', text: ctx.bootstrapText })
  }
  // MEMORY.md — profile-gated; treated as a stable snapshot
  // per design doc §1.2.
  if (ctx.profile.memorySnapshot === true && ctx.memorySnapshotText !== undefined && ctx.memorySnapshotText.length > 0) {
    sections.push({ id: 'memorySnapshot', text: ctx.memorySnapshotText })
  }
  return sections
}

/**
 * Apply per-layer budgets; emit each section as
 * `## <id> (P31 layer)\n<text>` to keep the prose
 * self-describing when the LLM reads it back.
 */
export const renderStableText = (
  sections: ReadonlyArray<SectionPayload>,
  budget: LayerBudgets,
): string => {
  const out: string[] = []
  for (const s of sections) {
    const cap = budget[s.id] ?? DEFAULT_BUDGET[s.id]
    if (cap === undefined) continue
    let body = s.text
    if (s.id === 'skillsIndex') {
      // Specialised render path (already handles its own cap).
      // Section payload arrived as already-rendered text, but
      // we re-clamp it to the per-layer maxChars here.
      body = truncateSection(body, cap)
    } else {
      body = truncateSection(body, cap)
    }
    if (body.length === 0) continue
    out.push(`## ${s.id}\n${body}`)
  }
  return out.join('\n\n')
}

/**
 * Build the full system prompt per §1.5. Single entry
 * point used by `Agent.run` (P31.6) and any other caller
 * (Gateway, sub-agent adapter, CLI preview).
 *
 * The function is *pure*: same `ctx` yields same output
 * modulo `runtime.capturedAtIso` (D1 timestamp) and
 * `middlewareDynamicChunks` (D2 turn-inject). Callers that
 * want byte-stable prefix across turns must keep `ctx`
 * stable for the non-runtime fields.
 */
export const buildSystemPrompt = (ctx: SectionContext): string => {
  const dynamic = renderRuntimeBlock(ctx.runtime, {})
  return assembleWith(ctx, dynamic, ctx.middlewareDynamicChunks ?? [])
}

/**
 * Lower-level variant for callers that need to thread the
 * dynamic runtime string explicitly (e.g. when a hook
 * rewrites the runtime to inject extra metadata while
 * keeping sections stable).
 */
export const assembleWith = (
  ctx: SectionContext,
  runtime: string,
  middlewareChunks: ReadonlyArray<string>,
): string => {
  const sections = collectStableSections(ctx)
  const stable = renderStableText(sections, {})
  return joinWithBoundary(stable, [runtime, ...middlewareChunks].filter((l) => l.length > 0).join('\n\n'))
}

export interface SummaryCounters {
  readonly stableChars: number
  readonly dynamicChars: number
  readonly perLayerChars: ReadonlyArray<readonly [SectionId, number]>
}

/**
 * Cheap `chars/4` token estimate per design doc §1.7. Used
 * for telemetry + total-budget enforcement (no truncation,
 * just a number to attach to logs).
 */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4)

export const summarize = (full: string): SummaryCounters => {
  const { prefix, suffix } = splitByBoundary(full)
  const perLayerChars: Array<readonly [SectionId, number]> = []
  // Best-effort per-layer breakdown: split the prefix by
  // the literal "## <id>\n" anchor. Unknown layers all
  // collapse to the implicit "section" bucket.
  const idPattern = /(^|\n)## ([a-zA-Z]+)\n/g
  let cursor = 0
  let m: RegExpExecArray | null
  const idStarts: Array<readonly [SectionId, number]> = []
  while ((m = idPattern.exec(prefix)) !== null) {
    idStarts.push([m[2] as SectionId, m.index + m[0].length])
    cursor = m.index + m[0].length
  }
  cursor = 0
  idStarts.push([undefined as unknown as SectionId, prefix.length])
  for (let i = 0; i < idStarts.length - 1; i++) {
    const cur = idStarts[i]!
    const next = idStarts[i + 1]!
    const len = next[1] - cur[1]
    if (cur[0] !== undefined) perLayerChars.push([cur[0], len])
    cursor = next[1]
  }
  void cursor
  return {
    stableChars: prefix.length,
    dynamicChars: suffix.length,
    perLayerChars,
  }
}

// Re-export boundary primitives so downstream callers can
// stay within the section layer's namespace.
export {
  appendDynamic,
  ensureSystemPromptCacheBoundary,
  joinWithBoundary,
  splitByBoundary,
  stripBoundary,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
}
