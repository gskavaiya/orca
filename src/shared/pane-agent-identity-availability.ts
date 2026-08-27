import type {
  PaneAgentIdentityAvailability,
  PaneAgentIdentityHostKind,
  PaneAgentIdentityLaunchMode
} from './pane-agent-identity-evidence'

export const PANE_AGENT_IDENTITY_MAX_COUNT = 1_000_000_000
export const PANE_AGENT_IDENTITY_MAX_BATCH_ROWS = 64
export const PANE_AGENT_IDENTITY_MAX_REMOTE_ENVIRONMENTS = 256
export {
  MAX_LIVE_FINALIZED_RUN_KEYS,
  MAX_PENDING_IDENTITY_OBSERVATIONS,
  PaneAgentIdentityObservationScheduler,
  RUN_SETTLE_MS,
  TITLE_CANDIDATE_WINDOW_MS,
  type PaneAgentIdentityObservationSchedulerDeps
} from './pane-agent-identity-observation-scheduler'

export type PaneAgentIdentityAggregate = {
  hostKind: PaneAgentIdentityHostKind
  launchMode: PaneAgentIdentityLaunchMode
  attestedRuns: number
  noEvidence: number
  titleOnly: number
  identityNull: number
  ambiguousTopRank: number
}

export type PaneAgentIdentityCandidateCoverage = {
  hostKind: PaneAgentIdentityHostKind
  exposures: number
}

export type PaneAgentIdentityAggregateWireRow = readonly [
  hostKind: PaneAgentIdentityHostKind,
  launchMode: PaneAgentIdentityLaunchMode,
  attestedRuns: number,
  noEvidence: number,
  titleOnly: number,
  identityNull: number,
  ambiguousTopRank: number
]

export type PaneAgentIdentityCandidateCoverageWireRow = readonly [
  hostKind: PaneAgentIdentityHostKind,
  exposures: number
]

export type PaneAgentIdentityAvailabilitySnapshot = {
  epoch: string
  revision: number
  /** Compact fixed tuples keep the cumulative field below the terminal-list wire budget. */
  rows: readonly PaneAgentIdentityAggregateWireRow[]
  candidateCoverage?: readonly PaneAgentIdentityCandidateCoverageWireRow[]
}

export function emptyPaneAgentIdentityAggregate(
  hostKind: PaneAgentIdentityHostKind,
  launchMode: PaneAgentIdentityLaunchMode
): PaneAgentIdentityAggregate {
  return {
    hostKind,
    launchMode,
    attestedRuns: 0,
    noEvidence: 0,
    titleOnly: 0,
    identityNull: 0,
    ambiguousTopRank: 0
  }
}

function addCount(value: number, amount: number): number {
  return Math.min(PANE_AGENT_IDENTITY_MAX_COUNT, value + Math.max(0, Math.floor(amount)))
}

export function aggregatePaneAgentIdentityAvailability(
  row: PaneAgentIdentityAvailability,
  aggregate = emptyPaneAgentIdentityAggregate(row.hostKind, row.launchMode)
): PaneAgentIdentityAggregate {
  const titleOnly = row.sourceMask === 64
  return {
    ...aggregate,
    attestedRuns: addCount(aggregate.attestedRuns, 1),
    noEvidence: addCount(aggregate.noEvidence, row.sourceMask === 0 ? 1 : 0),
    titleOnly: addCount(aggregate.titleOnly, titleOnly ? 1 : 0),
    identityNull: addCount(aggregate.identityNull, row.identityNull ? 1 : 0),
    ambiguousTopRank: addCount(aggregate.ambiguousTopRank, row.ambiguousTopRank ? 1 : 0)
  }
}

export type RelayMergeResult =
  | { kind: 'baseline' }
  | {
      kind: 'delta'
      rows: PaneAgentIdentityAggregate[]
      candidateCoverage: PaneAgentIdentityCandidateCoverage[]
    }
  | { kind: 'stale' }
  | {
      kind: 'failed-closed'
      reason: 'epoch-changed' | 'counter-regressed' | 'capacity'
    }
  | { kind: 'unavailable' }

type RelayState = {
  epoch: string
  revision: number
  rows: Map<string, PaneAgentIdentityAggregate>
  candidates: Map<PaneAgentIdentityHostKind, number>
  failedClosedReason: 'epoch-changed' | 'counter-regressed' | null
}

const rowKey = (row: PaneAgentIdentityAggregate): string => `${row.hostKind}:${row.launchMode}`
const COUNTER_KEYS = [
  'attestedRuns',
  'noEvidence',
  'titleOnly',
  'identityNull',
  'ambiguousTopRank'
] as const

const decodeAggregateRow = (
  row: PaneAgentIdentityAggregateWireRow
): PaneAgentIdentityAggregate => ({
  hostKind: row[0],
  launchMode: row[1],
  attestedRuns: row[2],
  noEvidence: row[3],
  titleOnly: row[4],
  identityNull: row[5],
  ambiguousTopRank: row[6]
})

/** Session-scoped cumulative snapshot merger. State is intentionally not evicted. */
export class PaneAgentIdentityRelaySnapshotMerger {
  private readonly states = new Map<string, RelayState>()
  private readonly maxEnvironments: number
  constructor(maxEnvironments = PANE_AGENT_IDENTITY_MAX_REMOTE_ENVIRONMENTS) {
    this.maxEnvironments = maxEnvironments
  }

  merge(
    environmentKey: string,
    snapshot: PaneAgentIdentityAvailabilitySnapshot | undefined
  ): RelayMergeResult {
    if (
      !snapshot ||
      typeof snapshot.epoch !== 'string' ||
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 0
    ) {
      return { kind: 'unavailable' }
    }
    let state = this.states.get(environmentKey)
    const decodedRows = snapshot.rows.map(decodeAggregateRow)
    if (!state) {
      if (this.states.size >= this.maxEnvironments) {
        return { kind: 'failed-closed', reason: 'capacity' }
      }
      state = {
        epoch: snapshot.epoch,
        revision: snapshot.revision,
        rows: new Map(decodedRows.map((row) => [rowKey(row), row])),
        candidates: new Map((snapshot.candidateCoverage ?? []).map((row) => [row[0], row[1]])),
        failedClosedReason: null
      }
      this.states.set(environmentKey, state)
      return { kind: 'baseline' }
    }
    if (state.failedClosedReason) {
      return { kind: 'failed-closed', reason: state.failedClosedReason }
    }
    if (state.epoch !== snapshot.epoch) {
      state.failedClosedReason = 'epoch-changed'
      return { kind: 'failed-closed', reason: 'epoch-changed' }
    }
    if (snapshot.revision <= state.revision) {
      return { kind: 'stale' }
    }
    const incomingRows = new Map(decodedRows.map((row) => [rowKey(row), row]))
    const incomingCandidates = new Map(
      (snapshot.candidateCoverage ?? []).map((row) => [row[0], row[1]])
    )
    const counterRegressed =
      [...state.rows].some(([key, previous]) => {
        const incoming = incomingRows.get(key)
        return !incoming || COUNTER_KEYS.some((counter) => incoming[counter] < previous[counter])
      }) ||
      [...state.candidates].some(
        ([hostKind, previous]) => (incomingCandidates.get(hostKind) ?? -1) < previous
      )
    if (counterRegressed) {
      state.failedClosedReason = 'counter-regressed'
      return { kind: 'failed-closed', reason: 'counter-regressed' }
    }
    const deltas: PaneAgentIdentityAggregate[] = []
    for (const incoming of decodedRows) {
      const previous =
        state.rows.get(rowKey(incoming)) ??
        emptyPaneAgentIdentityAggregate(incoming.hostKind, incoming.launchMode)
      const delta = {
        ...incoming,
        ...Object.fromEntries(
          COUNTER_KEYS.map((key) => [key, Math.max(0, incoming[key] - previous[key])])
        )
      } as PaneAgentIdentityAggregate
      if (COUNTER_KEYS.some((key) => delta[key] > 0)) {
        deltas.push(delta)
      }
      state.rows.set(rowKey(incoming), { ...incoming })
    }
    const candidateCoverage: PaneAgentIdentityCandidateCoverage[] = []
    for (const [hostKind, exposures] of incomingCandidates) {
      const delta = exposures - (state.candidates.get(hostKind) ?? 0)
      if (delta > 0) {
        candidateCoverage.push({ hostKind, exposures: delta })
      }
      state.candidates.set(hostKind, exposures)
    }
    state.revision = snapshot.revision
    return { kind: 'delta', rows: deltas, candidateCoverage }
  }

  clear(): void {
    this.states.clear()
  }
  get size(): number {
    return this.states.size
  }
}

export class PaneAgentIdentityAuthoritySnapshot {
  private readonly rows = new Map<string, PaneAgentIdentityAggregate>()
  private readonly candidates = new Map<PaneAgentIdentityHostKind, number>()
  private revision = 0
  constructor(private readonly epoch: string) {}

  record(observation: PaneAgentIdentityAvailability): void {
    const key = `${observation.hostKind}:${observation.launchMode}`
    this.rows.set(
      key,
      aggregatePaneAgentIdentityAvailability(
        observation,
        this.rows.get(key) ??
          emptyPaneAgentIdentityAggregate(observation.hostKind, observation.launchMode)
      )
    )
    this.revision += 1
  }

  recordCandidateCoverage(hostKind: PaneAgentIdentityHostKind, amount = 1): void {
    this.candidates.set(hostKind, addCount(this.candidates.get(hostKind) ?? 0, amount))
    this.revision += 1
  }

  snapshot(): PaneAgentIdentityAvailabilitySnapshot {
    const candidateCoverage: PaneAgentIdentityCandidateCoverageWireRow[] = [...this.candidates]
    return {
      epoch: this.epoch,
      revision: this.revision,
      rows: [...this.rows.values()].map(
        (row): PaneAgentIdentityAggregateWireRow => [
          row.hostKind,
          row.launchMode,
          row.attestedRuns,
          row.noEvidence,
          row.titleOnly,
          row.identityNull,
          row.ambiguousTopRank
        ]
      ),
      ...(candidateCoverage.length > 0 ? { candidateCoverage } : {})
    }
  }
}
