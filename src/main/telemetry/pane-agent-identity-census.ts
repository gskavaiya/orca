import {
  aggregatePaneAgentIdentityAvailability,
  emptyPaneAgentIdentityAggregate,
  PaneAgentIdentityRelaySnapshotMerger,
  PaneAgentIdentityAuthoritySnapshot,
  PANE_AGENT_IDENTITY_MAX_BATCH_ROWS,
  type PaneAgentIdentityAggregate,
  type PaneAgentIdentityAvailabilitySnapshot
} from '../../shared/pane-agent-identity-availability'
import type {
  PaneAgentIdentityAvailability,
  PaneAgentIdentityHostKind
} from '../../shared/pane-agent-identity-evidence'
import { track } from './client'
import { randomUUID } from 'node:crypto'

type CoverageReason =
  | 'snapshot'
  | 'baseline'
  | 'epoch_changed'
  | 'counter_regressed'
  | 'capacity'
  | 'candidate'
  | 'overflow'
  | 'truncated'
type AggregateRow = {
  kind: 'aggregate'
  host_kind: PaneAgentIdentityAggregate['hostKind']
  launch_mode: PaneAgentIdentityAggregate['launchMode']
  attested_runs: number
  no_evidence: number
  title_only: number
  identity_null: number
  ambiguous_top_rank: number
}
type CoverageRow = {
  kind: 'coverage'
  host_kind: PaneAgentIdentityAggregate['hostKind']
  reason: CoverageReason
  count: number
}
type TelemetryRow = AggregateRow | CoverageRow
type TelemetryEmitter = (rows: readonly TelemetryRow[]) => void
type PaneAgentIdentityCensusOptions = {
  emit: TelemetryEmitter | null
  snapshotHostKind?: PaneAgentIdentityHostKind
  epoch?: string
}

const keyOf = (hostKind: string, launchMode: string): string => `${hostKind}:${launchMode}`

export class PaneAgentIdentityCensus {
  private readonly aggregate = new Map<string, PaneAgentIdentityAggregate>()
  private readonly relay = new PaneAgentIdentityRelaySnapshotMerger()
  private readonly coverage = new Map<string, CoverageRow>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private readonly emit: TelemetryEmitter | null
  private readonly snapshotHostKind: PaneAgentIdentityHostKind | undefined
  private readonly authoritySnapshot: PaneAgentIdentityAuthoritySnapshot

  constructor(input: TelemetryEmitter | PaneAgentIdentityCensusOptions = defaultOptions()) {
    const options = typeof input === 'function' ? { emit: input } : input
    this.emit = options.emit
    this.snapshotHostKind = options.snapshotHostKind
    this.authoritySnapshot = new PaneAgentIdentityAuthoritySnapshot(options.epoch ?? randomUUID())
  }

  record(row: PaneAgentIdentityAvailability): void {
    if (this.closed) {
      return
    }
    const normalized = this.normalizeObservation(row)
    this.authoritySnapshot.record(normalized)
    if (!this.emit) {
      return
    }
    const key = keyOf(normalized.hostKind, normalized.launchMode)
    this.aggregate.set(
      key,
      aggregatePaneAgentIdentityAvailability(
        normalized,
        this.aggregate.get(key) ??
          emptyPaneAgentIdentityAggregate(normalized.hostKind, normalized.launchMode)
      )
    )
    this.scheduleFlush()
  }

  ingestRelaySnapshot(
    environmentKey: string,
    snapshot: PaneAgentIdentityAvailabilitySnapshot | undefined
  ): void {
    if (this.closed) {
      return
    }
    const result = this.relay.merge(environmentKey, snapshot)
    if (result.kind !== 'unavailable') {
      this.addCoverage('relay', 'snapshot')
    }
    if (result.kind === 'delta' || result.kind === 'baseline') {
      for (const row of result.rows) {
        // Apply cumulative deltas without reclassifying every run.
        const key = keyOf(row.hostKind, row.launchMode)
        const previous =
          this.aggregate.get(key) ?? emptyPaneAgentIdentityAggregate(row.hostKind, row.launchMode)
        this.aggregate.set(key, {
          ...previous,
          attestedRuns: Math.min(1_000_000_000, previous.attestedRuns + row.attestedRuns),
          noEvidence: Math.min(1_000_000_000, previous.noEvidence + row.noEvidence),
          titleOnly: Math.min(1_000_000_000, previous.titleOnly + row.titleOnly),
          identityNull: Math.min(1_000_000_000, previous.identityNull + row.identityNull),
          ambiguousTopRank: Math.min(
            1_000_000_000,
            previous.ambiguousTopRank + row.ambiguousTopRank
          )
        })
      }
      for (const candidate of result.candidateCoverage) {
        this.addTelemetryCoverage(candidate.hostKind, 'candidate', candidate.exposures)
      }
    }
    if (result.kind === 'baseline') {
      this.addCoverage('relay', 'baseline')
    } else if (result.kind === 'failed-closed') {
      this.addCoverage(
        'relay',
        result.reason === 'capacity'
          ? 'capacity'
          : result.reason === 'counter-regressed'
            ? 'counter_regressed'
            : 'epoch_changed'
      )
    }
  }

  addCoverage(
    hostKind: PaneAgentIdentityAggregate['hostKind'],
    reason: CoverageReason,
    amount = 1
  ): void {
    if (this.closed) {
      return
    }
    const normalizedHostKind = this.snapshotHostKind ?? hostKind
    if (reason === 'candidate') {
      this.authoritySnapshot.recordCandidateCoverage(normalizedHostKind, amount)
    }
    this.addTelemetryCoverage(normalizedHostKind, reason, amount)
  }

  private addTelemetryCoverage(
    hostKind: PaneAgentIdentityAggregate['hostKind'],
    reason: CoverageReason,
    amount: number
  ): void {
    if (!this.emit) {
      return
    }
    const key = `${hostKind}:${reason}`
    const previous = this.coverage.get(key)
    this.coverage.set(key, {
      kind: 'coverage',
      host_kind: hostKind,
      reason,
      count: Math.min(1_000_000_000, (previous?.count ?? 0) + Math.max(0, Math.floor(amount)))
    })
    this.scheduleFlush()
  }

  scheduleFlush(delayMs = 300_000): void {
    if (this.closed || !this.emit || this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, delayMs)
    this.timer.unref?.()
  }

  flush(): void {
    if (this.closed) {
      return
    }
    const rows: TelemetryRow[] = [...this.aggregate.values()].map((row) => ({
      kind: 'aggregate',
      host_kind: row.hostKind,
      launch_mode: row.launchMode,
      attested_runs: row.attestedRuns,
      no_evidence: row.noEvidence,
      title_only: row.titleOnly,
      identity_null: row.identityNull,
      ambiguous_top_rank: row.ambiguousTopRank
    }))
    for (const coverage of this.coverage.values()) {
      rows.push(coverage)
    }
    if (rows.length === 0) {
      return
    }
    for (let offset = 0; offset < rows.length; offset += PANE_AGENT_IDENTITY_MAX_BATCH_ROWS) {
      this.emit?.(rows.slice(offset, offset + PANE_AGENT_IDENTITY_MAX_BATCH_ROWS))
    }
    this.aggregate.clear()
    this.coverage.clear()
  }

  shutdown(): void {
    this.closed = true
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = undefined
    this.aggregate.clear()
    this.coverage.clear()
    this.relay.clear()
  }

  snapshot(): PaneAgentIdentityAvailabilitySnapshot {
    return this.authoritySnapshot.snapshot()
  }

  hostKindsForObservation(
    hostKinds: readonly PaneAgentIdentityHostKind[]
  ): readonly PaneAgentIdentityHostKind[] {
    return this.snapshotHostKind ? [this.snapshotHostKind] : hostKinds
  }

  private normalizeObservation(row: PaneAgentIdentityAvailability): PaneAgentIdentityAvailability {
    return this.snapshotHostKind ? { ...row, hostKind: this.snapshotHostKind } : row
  }
}

function defaultOptions(): PaneAgentIdentityCensusOptions {
  return {
    emit: (rows) => track('pane_agent_identity_availability', { rows: [...rows] })
  }
}

export type PaneAgentIdentityTelemetryRow = TelemetryRow
