/** What a Rosetta-Jane gateway reports about itself and the swarm it can see. */
export type RosettaServiceState = {
  on: boolean
  layers: [number, number]
  training: boolean
  stepsHelped: number
  examplesHelped: number
}

/**
 * A score card: the unchanged model against the model with the adapter, on the same pairs.
 * It informs the decision to use an adapter. Nothing applies one, whatever it scores.
 */
export type RosettaScore = {
  pairs: number
  neverTrainedOn: boolean
  /** Share of answer words predicted correctly, 0 to 1, without and with the adapter. */
  rightBefore: number
  rightAfter: number
  lossBefore: number
  lossAfter: number
  verdict: string
  workUnchecked: number
}

export type RosettaTrainingState =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'scoring'
  | 'stopped'
  | 'done'
  | 'failed'

export type RosettaTraining = {
  name: string
  state: RosettaTrainingState
  error: string | null
  step: number
  totalSteps: number
  pairs: number
  pairsCutShort: number
  loss: number | null
  checked: number
  unchecked: number
  peersBlocked: number
  redone: number
  seconds: number
  /** Pairs never trained on, kept back to score the result with. */
  pairsKeptBack: number
  score: RosettaScore | null
  adapter: string | null
}

export type RosettaStatus = {
  version: string
  model: string
  layers: number
  ownLayers: number
  peersKnown: number
  peersServing: number
  layersMissing: number[]
  thinnestCover: number
  canAnswer: boolean
  peersBlocked: number
  checks: {
    comparePeers: 'auto' | number
    recheckHere: boolean
    knownAnswers: boolean
    requireChecked: boolean
  }
  lastAnswer: {
    at: string
    peersUsed: number
    checkedSteps: number
    uncheckedSteps: number
    peersBlocked: number
  } | null
  controls: boolean
  service: RosettaServiceState | null
  training: RosettaTraining | null
  adapters: string[]
  adapterDetails: RosettaAdapterInfo[]
  adapterJob: RosettaAdapterJob | null
}

export type RosettaAdapterInfo = {
  name: string
  /** Shared by someone else, as opposed to trained through this gateway. */
  received: boolean
  /** Has a score from the run that trained it. */
  scored: boolean
  /** Has been scored here, on this user's own questions. */
  myScore: boolean
}

/** One question of a trial, with the conversation so far on each side. */
export type RosettaTrialItem = {
  without: { role: 'user' | 'assistant' | 'system'; content: string }[]
  with: { role: 'user' | 'assistant' | 'system'; content: string }[]
}

/** Scoring or trying an adapter in the background. A trial applies nothing. */
export type RosettaAdapterJob = {
  kind: 'score' | 'try'
  name: string
  state: 'running' | 'done' | 'stopped' | 'failed'
  error: string | null
  done: number
  total: number
  /** For a trial: each question answered without the adapter and with it. */
  answers: { without: string; with: string }[]
  /** For a scoring: the card as lines, and as text the user may choose to share. */
  lines: string[]
  shareText: string
}

export type RosettaPair = { question: string; answer: string }

export type RosettaTrainingRequest = {
  pairs: RosettaPair[]
  name: string
  epochs: number
}

/** What the settings page is given. The control token itself never leaves the server. */
export type RosettaOverview = {
  url: string
  hasToken: boolean
  /** Null when no gateway is configured or it did not answer; `error` then says why. */
  status: RosettaStatus | null
  error: string | null
  /** Whether chat currently goes through this gateway. */
  usedForChat: boolean
  /** Whether knowledge-base indexing is pinned to this machine (it must be: the swarm cannot embed). */
  localEmbeddings: boolean
}
