import type {
  RosettaServiceState,
  RosettaPair,
  RosettaAdapterJob,
  RosettaScore,
  RosettaStatus,
  RosettaTraining,
  RosettaTrialItem,
  RosettaTrainingState,
} from '../../types/rosetta_jane.js'

/**
 * Pure helpers for talking to a Rosetta-Jane gateway: the peer-to-peer backend
 * that answers and trains through other people's devices. No Adonis imports, so
 * everything here runs under `node --test`.
 *
 * A gateway is another program, possibly on another machine. Nothing it sends is
 * trusted: every field is checked and coerced before the rest of NOMAD sees it.
 */

export const ROSETTA_TIMEOUT_MS = 5000
/** Starting a run tokenizes every pair on the gateway before it answers. */
export const ROSETTA_TRAIN_TIMEOUT_MS = 120_000
/** A score document is a table of numbers. Anything far larger than that is not one. */
export const ROSETTA_SCORE_DOCUMENT_MAX = 8 * 1024 * 1024
export const ROSETTA_MAX_PAIRS = 50_000
export const ROSETTA_MAX_FILE_BYTES = 24 * 1024 * 1024
export const ROSETTA_DEFAULT_URL = 'http://host.docker.internal:11435'

const TRAINING_STATES: RosettaTrainingState[] = [
  'starting',
  'running',
  'stopping',
  'scoring',
  'stopped',
  'done',
  'failed',
]

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function text(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function normalizeService(raw: any): RosettaServiceState | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.layers)) return null
  return {
    on: raw.on === true,
    layers: [num(raw.layers[0]), num(raw.layers[1])],
    training: raw.training === true,
    stepsHelped: num(raw.steps_helped),
    examplesHelped: num(raw.examples_helped),
  }
}

export function normalizeAdapterJob(raw: any): RosettaAdapterJob | null {
  if (!raw || typeof raw !== 'object' || !['score', 'try'].includes(raw.kind)) return null
  if (!['running', 'done', 'stopped', 'failed'].includes(raw.state)) return null
  const result = raw.result && typeof raw.result === 'object' ? raw.result : {}
  return {
    kind: raw.kind,
    name: text(raw.name, 40),
    state: raw.state,
    error: raw.error ? text(raw.error) : null,
    done: num(raw.done),
    total: num(raw.total),
    answers: Array.isArray(result.answers)
      ? result.answers
          .filter((a: any) => a && typeof a.without === 'string' && typeof a.with === 'string')
          .slice(0, 50)
          .map((a: any) => ({ without: text(a.without, 8000), with: text(a.with, 8000) }))
      : [],
    lines: Array.isArray(result.lines)
      ? result.lines
          .filter((l: unknown) => typeof l === 'string')
          .map((l: string) => l.slice(0, 400))
          .slice(0, 12)
      : [],
    shareText: text(result.share_text, 2000),
  }
}

/**
 * The questions of a trial as the gateway wants them. A list of separate questions and a
 * continuing chat are the same request: each item carries the conversation so far on both
 * sides, and in a chat each side carries its own earlier replies forward.
 */
export function trialItems(
  questions: string[],
  history: { question: string; without: string; with: string }[] = []
): RosettaTrialItem[] {
  const past = (side: 'without' | 'with') =>
    history.flatMap((turn) => [
      { role: 'user' as const, content: turn.question },
      { role: 'assistant' as const, content: turn[side] || '(no reply)' },
    ])
  return questions
    .map((q) => q.trim())
    .filter((q) => q.length > 0)
    .slice(0, 50)
    .map((q) => ({
      without: [...past('without'), { role: 'user' as const, content: q }],
      with: [...past('with'), { role: 'user' as const, content: q }],
    }))
}

export function normalizeScore(raw: any): RosettaScore | null {
  const before = raw?.before
  const after = raw?.after
  const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  if (!raw || typeof raw !== 'object' || !before || !after) return null
  if (![before.loss, after.loss, before.right_next_word, after.right_next_word].every(ok))
    return null
  return {
    pairs: num(raw.pairs),
    neverTrainedOn: raw.never_trained_on === true,
    rightBefore: Math.min(1, Math.max(0, before.right_next_word)),
    rightAfter: Math.min(1, Math.max(0, after.right_next_word)),
    lossBefore: before.loss,
    lossAfter: after.loss,
    verdict: text(raw.verdict, 200),
    workUnchecked: num(raw.work_unchecked),
  }
}

/** A score card as one line for the page. Percentages are of answer words predicted correctly. */
export function describeScore(score: RosettaScore): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`
  return (
    `Scored on ${score.pairs} pair${score.pairs === 1 ? '' : 's'} ` +
    (score.neverTrainedOn ? 'kept back from training' : 'chosen by the person scoring') +
    `: ${pct(score.rightBefore)} of answer words right without the adapter, ${pct(score.rightAfter)} with it. ` +
    `Result: ${score.verdict}.`
  )
}

export function normalizeTraining(raw: any): RosettaTraining | null {
  if (!raw || typeof raw !== 'object' || !TRAINING_STATES.includes(raw.state)) return null
  return {
    name: text(raw.name, 40),
    state: raw.state,
    error: raw.error ? text(raw.error) : null,
    step: num(raw.step),
    totalSteps: num(raw.total_steps),
    pairs: num(raw.pairs),
    pairsCutShort: num(raw.pairs_cut_short),
    loss: typeof raw.loss === 'number' && Number.isFinite(raw.loss) ? raw.loss : null,
    checked: num(raw.checked),
    unchecked: num(raw.unchecked),
    peersBlocked: num(raw.peers_blocked),
    redone: num(raw.redone),
    seconds: num(raw.seconds),
    pairsKeptBack: num(raw.pairs_kept_back),
    score: normalizeScore(raw.score),
    adapter: raw.adapter ? text(raw.adapter) : null,
  }
}

/** The gateway's /api/rosetta/status body as a typed record, or null if it is not one. */
export function normalizeStatus(raw: any): RosettaStatus | null {
  if (!raw || typeof raw !== 'object' || typeof raw.rosetta_jane !== 'string') return null
  if (typeof raw.model !== 'string' || typeof raw.layers !== 'number') return null
  const checks = raw.checks && typeof raw.checks === 'object' ? raw.checks : {}
  const last = raw.last_answer && typeof raw.last_answer === 'object' ? raw.last_answer : null
  return {
    version: text(raw.rosetta_jane, 40),
    model: text(raw.model, 200),
    layers: num(raw.layers),
    ownLayers: num(raw.own_layers),
    peersKnown: num(raw.peers_known),
    peersServing: num(raw.peers_serving),
    layersMissing: Array.isArray(raw.layers_missing)
      ? raw.layers_missing.filter((n: unknown) => typeof n === 'number').slice(0, 4096)
      : [],
    thinnestCover: num(raw.thinnest_cover),
    canAnswer: raw.can_answer === true,
    peersBlocked: num(raw.peers_blocked),
    checks: {
      comparePeers: typeof checks.compare_peers === 'number' ? checks.compare_peers : 'auto',
      recheckHere: checks.recheck_here === true,
      knownAnswers: checks.known_answers === true,
      requireChecked: checks.require_checked === true,
    },
    lastAnswer: last
      ? {
          at: text(last.at, 40),
          peersUsed: num(last.peers_used),
          checkedSteps: num(last.checked_steps),
          uncheckedSteps: num(last.unchecked_steps),
          peersBlocked: num(last.peers_blocked),
        }
      : null,
    controls: raw.controls === true,
    service: normalizeService(raw.service),
    training: normalizeTraining(raw.training),
    adapters: Array.isArray(raw.adapters)
      ? raw.adapters.filter((n: unknown) => typeof n === 'string').slice(0, 200)
      : [],
    adapterDetails: Array.isArray(raw.adapter_details)
      ? raw.adapter_details
          .filter((a: any) => a && typeof a.name === 'string')
          .slice(0, 200)
          .map((a: any) => ({
            name: text(a.name, 40),
            received: a.received === true,
            scored: a.scored === true,
            myScore: a.my_score === true,
          }))
      : [],
    adapterJob: normalizeAdapterJob(raw.adapter_job),
  }
}

/** "8, 9, 10, 14" -> "8-10, 14". For telling the user which layers nobody is serving. */
export function layerRanges(layers: number[]): string {
  const sorted = [...new Set(layers)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`)
    i = j + 1
  }
  return parts.join(', ')
}

export type SwarmHealth = { level: 'ok' | 'warning' | 'error'; headline: string; detail: string }

/**
 * One plain-language verdict on the swarm, worst problem first. An unchecked
 * swarm is a warning rather than OK: answers arrive, but a single peer could be
 * steering them and nothing would notice.
 */
export function describeSwarm(status: RosettaStatus): SwarmHealth {
  if (!status.canAnswer) {
    const missing = layerRanges(status.layersMissing)
    return {
      level: 'error',
      headline: 'The swarm cannot answer right now',
      detail:
        status.peersServing === 0
          ? 'No device in your group is serving this model. Check the group code and that at least one peer is running the p2p service.'
          : `Nobody is serving layers ${missing} of ${status.layers}. Answers need every layer covered. A device that starts serving without choosing layers takes the missing ones by itself.`,
    }
  }
  const compares =
    status.checks.comparePeers === 'auto'
      ? status.thinnestCover >= 2 && status.peersServing >= 3
      : status.checks.comparePeers >= 2 && status.thinnestCover >= 2
  if (!compares && !status.checks.recheckHere && !status.checks.knownAnswers) {
    return {
      level: 'warning',
      headline: 'Answers are not being checked',
      detail:
        'Only one device covers some layers and no known-answer tests are prepared, so a peer returning wrong results would not be noticed. Known-answer tests are normally prepared by the gateway on its first start; restart it without --no-known-answers or --no-auto-calibrate, or wait for more serving peers.',
    }
  }
  if (!compares) {
    return {
      level: 'ok',
      headline: 'Ready',
      detail: `${status.peersServing} serving peer${status.peersServing === 1 ? '' : 's'}. Some layers have a single serving peer, so results there rely on ${status.checks.recheckHere ? 'rechecking on the gateway' : 'known-answer tests'} rather than comparison between peers.`,
    }
  }
  return {
    level: 'ok',
    headline: 'Ready',
    detail: `${status.peersServing} serving peers, at least ${status.thinnestCover} for every layer. Results are compared between peers.`,
  }
}

export function trainingPercent(job: RosettaTraining): number {
  if (job.totalSteps <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((job.step / job.totalSteps) * 100)))
}

export function isTrainingActive(job: RosettaTraining | null): boolean {
  return !!job && ['starting', 'running', 'stopping', 'scoring'].includes(job.state)
}

export type ParsedPairs = { pairs: RosettaPair[]; problems: string[] }

/**
 * Read question/answer pairs from an uploaded file: either JSON Lines (one
 * object per line, the format the training guide uses) or a single JSON array.
 * Accepts the common alternative field names so a file exported elsewhere works.
 * Bad lines are reported, up to a handful, rather than silently skipped.
 */
export function parseTrainingPairs(source: string): ParsedPairs {
  const problems: string[] = []
  const pairs: RosettaPair[] = []
  const note = (message: string) => {
    if (problems.length < 5) problems.push(message)
  }
  const take = (row: any, where: string) => {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      return note(`${where} is not an object`)
    const question = row.question ?? row.prompt ?? row.instruction ?? row.input
    const answer = row.answer ?? row.response ?? row.output ?? row.completion
    if (typeof question !== 'string' || !question.trim()) return note(`${where} has no question`)
    if (typeof answer !== 'string' || !answer.trim()) return note(`${where} has no answer`)
    pairs.push({ question: question.trim(), answer: answer.trim() })
  }

  const trimmed = (source.charCodeAt(0) === 0xfeff ? source.slice(1) : source).trim()
  if (!trimmed) return { pairs, problems: ['The file is empty.'] }

  if (trimmed.startsWith('[')) {
    try {
      const rows = JSON.parse(trimmed)
      if (!Array.isArray(rows)) throw new Error('not a list')
      rows.forEach((row, i) => take(row, `Item ${i + 1}`))
    } catch {
      problems.push('The file starts like a JSON list but is not valid JSON.')
    }
  } else {
    trimmed.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return
      try {
        take(JSON.parse(line), `Line ${i + 1}`)
      } catch {
        note(`Line ${i + 1} is not valid JSON`)
      }
    })
  }
  if (pairs.length > ROSETTA_MAX_PAIRS) {
    problems.push(`Only the first ${ROSETTA_MAX_PAIRS} pairs are used.`)
    pairs.length = ROSETTA_MAX_PAIRS
  }
  return { pairs, problems }
}

/** A run name the gateway accepts: lowercase letters, digits and dashes, 40 at most. */
export function runNameFrom(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return cleaned || 'run'
}

export class RosettaError extends Error {
  constructor(
    message: string,
    public status: number | null = null
  ) {
    super(message)
  }
}

/**
 * Minimal HTTP client for one gateway. Reading needs no token; changing anything
 * does, and the gateway refuses without it.
 */
export class RosettaJaneClient {
  private base: string

  constructor(
    baseUrl: string,
    private token: string | null = null,
    private fetchImpl: typeof fetch = fetch
  ) {
    this.base = baseUrl.trim().replace(/\/+$/, '')
  }

  private async request(
    path: string,
    body?: unknown,
    timeoutMs = ROSETTA_TIMEOUT_MS
  ): Promise<any> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new RosettaError(
        `Could not reach Rosetta-Jane at ${this.base}. Is the gateway running, and listening on an address NOMAD can reach?`
      )
    }
    let data: any = null
    try {
      data = await response.json()
    } catch {
      /* handled below */
    }
    if (!response.ok) {
      if (response.status === 401) {
        throw new RosettaError('The control token is wrong. Copy it again from the gateway.', 401)
      }
      if (response.status === 403) {
        throw new RosettaError(
          'Controls are switched off on this gateway. Start it with --controls to manage it from here.',
          403
        )
      }
      throw new RosettaError(
        text(data?.error) || `Rosetta-Jane answered HTTP ${response.status}.`,
        response.status
      )
    }
    return data
  }

  async status(): Promise<RosettaStatus> {
    const status = normalizeStatus(await this.request('/api/rosetta/status'))
    if (!status) {
      throw new RosettaError('That address answered, but it is not a Rosetta-Jane gateway.')
    }
    return status
  }

  async setService(change: {
    on?: boolean
    training?: boolean
  }): Promise<RosettaServiceState | null> {
    const reply = await this.request('/api/rosetta/service', change)
    return normalizeService(reply?.service)
  }

  async startTraining(run: {
    pairs: RosettaPair[]
    name: string
    epochs: number
  }): Promise<RosettaTraining | null> {
    const reply = await this.request('/api/rosetta/train', run, ROSETTA_TRAIN_TIMEOUT_MS)
    return normalizeTraining(reply?.training)
  }

  async stopTraining(): Promise<RosettaTraining | null> {
    const reply = await this.request('/api/rosetta/train/stop', {})
    return normalizeTraining(reply?.training)
  }

  /**
   * A finished adapter as a zip. NOMAD only passes it to the browser: nothing
   * here loads or applies it. Using a model that strangers' hardware helped
   * train is a decision for a person to make, one adapter at a time.
   */
  async downloadAdapter(name: string): Promise<ArrayBuffer> {
    let response: Response
    try {
      response = await this.fetchImpl(
        `${this.base}/api/rosetta/adapters/${encodeURIComponent(name)}`,
        {
          headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
          signal: AbortSignal.timeout(ROSETTA_TRAIN_TIMEOUT_MS),
        }
      )
    } catch {
      throw new RosettaError(`Could not reach Rosetta-Jane at ${this.base}.`)
    }
    if (!response.ok) {
      throw new RosettaError(
        response.status === 404
          ? 'That adapter is no longer on the gateway.'
          : response.status === 401 || response.status === 403
            ? 'The gateway refused: check the control token.'
            : `Rosetta-Jane answered HTTP ${response.status}.`,
        response.status
      )
    }
    return response.arrayBuffer()
  }

  /**
   * The "Model Adapter Score" document: one landscape page, made by the gateway, that sets
   * every adapter it holds beside the unchanged model, by model then adapter, best first.
   * The gateway writes it as plain HTML with no scripts. NOMAD still treats it as a file
   * from another machine: it is handed to the browser as a download, never shown as a NOMAD page.
   */
  async scoreDocument(): Promise<string> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.base}/api/rosetta/model-adapter-score`, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        signal: AbortSignal.timeout(ROSETTA_TRAIN_TIMEOUT_MS),
      })
    } catch {
      throw new RosettaError(`Could not reach Rosetta-Jane at ${this.base}.`)
    }
    if (!response.ok) {
      throw new RosettaError(
        response.status === 401 || response.status === 403
          ? 'The gateway refused: check the control token.'
          : response.status === 404
            ? 'This gateway is too old to make the Model Adapter Score document. Update Rosetta-Jane.'
            : `Rosetta-Jane answered HTTP ${response.status}.`,
        response.status
      )
    }
    const page = await response.text()
    if (page.length > ROSETTA_SCORE_DOCUMENT_MAX) {
      throw new RosettaError('The gateway sent a score document too large to accept.')
    }
    return page
  }

  /**
   * The score card saved with a finished adapter, as text its owner can choose to share.
   * NOMAD shows it and offers to copy it. It is never sent anywhere from here.
   */
  async scoreCard(name: string): Promise<{ lines: string[]; shareText: string }> {
    const reply = await this.request(`/api/rosetta/adapters/${encodeURIComponent(name)}/score-card`)
    return {
      lines: Array.isArray(reply?.lines)
        ? reply.lines
            .filter((l: unknown) => typeof l === 'string')
            .map((l: string) => l.slice(0, 400))
            .slice(0, 12)
        : [],
      shareText: text(reply?.share_text, 2000),
    }
  }

  /** Store an adapter someone shared (the zip they downloaded). Storing applies nothing. */
  async importAdapter(name: string, zip: Uint8Array): Promise<void> {
    let response: Response
    try {
      response = await this.fetchImpl(
        `${this.base}/api/rosetta/adapters/import?name=${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/zip',
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
          body: zip,
          signal: AbortSignal.timeout(ROSETTA_TRAIN_TIMEOUT_MS),
        }
      )
    } catch {
      throw new RosettaError(`Could not reach Rosetta-Jane at ${this.base}.`)
    }
    if (!response.ok) {
      let message = ''
      try {
        const data: any = await response.json()
        message = text(data?.error)
      } catch {
        /* handled below */
      }
      throw new RosettaError(
        response.status === 401 || response.status === 403
          ? 'The gateway refused: check the control token.'
          : message || `Rosetta-Jane answered HTTP ${response.status}.`,
        response.status
      )
    }
  }

  /** Score an adapter on the user's own pairs. Runs in the background; watch status().adapterJob. */
  async scoreAdapter(name: string, pairs: RosettaPair[]): Promise<void> {
    await this.request('/api/rosetta/adapters/score', { name, pairs }, ROSETTA_TRAIN_TIMEOUT_MS)
  }

  /** Answer each question twice, without the adapter and with it. A trial: nothing is applied. */
  async tryAdapter(name: string, items: RosettaTrialItem[], maxNew: number): Promise<void> {
    await this.request(
      '/api/rosetta/adapters/try',
      { name, items, max_new: maxNew },
      ROSETTA_TRAIN_TIMEOUT_MS
    )
  }

  async stopAdapterJob(): Promise<void> {
    await this.request('/api/rosetta/adapters/stop', {})
  }

  /** Proves the token works without changing anything: an empty serving change is a no-op. */
  async checkToken(): Promise<void> {
    await this.request('/api/rosetta/service', {})
  }
}
