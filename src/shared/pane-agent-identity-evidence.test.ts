import { describe, expect, it } from 'vitest'
import {
  assemblePaneAgentIdentityEvidence,
  reducePaneAgentIdentityAvailability
} from './pane-agent-identity-evidence'
import {
  aggregatePaneAgentIdentityAvailability,
  PaneAgentIdentityRelaySnapshotMerger
} from './pane-agent-identity-availability'
import { isPaneAgentIdentityAvailabilitySnapshot } from './pane-agent-identity-availability-validator'
import {
  MANUAL_AGENT_COMMAND_MAX_CHARS,
  ManualAgentCommandTracker
} from './manual-agent-command-tracker'
import { eventSchemas } from './telemetry-events'

describe('pane identity evidence census', () => {
  it('returns eligible evidence in the canonical resolver order', () => {
    expect(
      assemblePaneAgentIdentityEvidence({
        facts: [
          { source: 'title', agent: 'codex' },
          { source: 'completed-hook', agent: 'codex' },
          {
            source: 'process',
            agent: 'codex',
            executionHostProvenance: 'execution-host'
          },
          { source: 'live-hook', agent: 'codex' }
        ]
      }).evidence.map((fact) => fact.source)
    ).toEqual(['live-hook', 'process', 'completed-hook', 'title'])
  })

  it('drops process facts without positive provenance and emits fixed source bits', () => {
    const result = assemblePaneAgentIdentityEvidence({
      facts: [
        { source: 'process', agent: 'codex', executionHostProvenance: undefined } as never,
        { source: 'title', agent: 'codex' }
      ]
    })
    expect(result.sourceMask).toBe(64)
    expect(result.identityNull).toBe(false)
  })

  it('reduces no evidence and ambiguity without exposing the winning agent', () => {
    expect(reducePaneAgentIdentityAvailability('native', 'typed', { facts: [] })).toMatchObject({
      sourceMask: 0,
      identityNull: true
    })
    const ambiguous = reducePaneAgentIdentityAvailability('native', 'orca-launch', {
      facts: [
        { source: 'live-hook', agent: 'codex' },
        { source: 'live-hook', agent: 'claude' }
      ]
    })
    expect(ambiguous.ambiguousTopRank).toBe(true)
    expect(ambiguous).not.toHaveProperty('resolvedAgent')
    expect(
      aggregatePaneAgentIdentityAvailability({
        hostKind: 'native',
        launchMode: 'typed',
        sourceMask: 64,
        identityNull: false,
        ambiguousTopRank: false
      }).titleOnly
    ).toBe(1)
  })

  it('excludes superseded and pane-ineligible evidence from the availability mask', () => {
    const currentRun = { authorityId: 'authority', incarnation: 2 }
    const result = reducePaneAgentIdentityAvailability('native', 'orca-launch', {
      currentRun,
      facts: [
        {
          source: 'live-hook',
          agent: 'claude',
          run: { authorityId: 'authority', incarnation: 1 }
        },
        { source: 'sibling', agent: 'claude', run: currentRun },
        { source: 'title', agent: 'codex', run: currentRun }
      ]
    })

    expect(result).toEqual({
      hostKind: 'native',
      launchMode: 'orca-launch',
      sourceMask: 64,
      identityNull: false,
      ambiguousTopRank: false
    })
  })

  it('uses same-run owner compatibility and preserves relay baselines', () => {
    const key = { authorityId: 'a', incarnation: 1 }
    expect(
      assemblePaneAgentIdentityEvidence({
        currentRun: key,
        owner: { agent: 'omp', run: key },
        facts: [{ source: 'launch', agent: 'pi', run: key }]
      }).resolvedAgent
    ).toBe('omp')
    expect(
      assemblePaneAgentIdentityEvidence({
        currentRun: key,
        owner: { agent: 'claude', run: key },
        facts: [{ source: 'launch', agent: 'codex', run: key }]
      }).resolvedAgent
    ).toBe('codex')
    const merger = new PaneAgentIdentityRelaySnapshotMerger()
    const snapshot = {
      epoch: 'e',
      revision: 1,
      rows: [['relay', 'typed', 1, 1, 0, 1, 0] as const]
    }
    expect(merger.merge('env', snapshot)).toMatchObject({
      kind: 'baseline',
      rows: [
        {
          hostKind: 'relay',
          launchMode: 'typed',
          attestedRuns: 1,
          noEvidence: 1,
          titleOnly: 0,
          identityNull: 1,
          ambiguousTopRank: 0
        }
      ],
      candidateCoverage: []
    })
    expect(merger.merge('env', { ...snapshot, revision: 0 })).toEqual({ kind: 'stale' })
    expect(
      merger.merge('env', {
        ...snapshot,
        revision: 2,
        rows: [['relay', 'typed', 2, 1, 0, 1, 0] as const]
      })
    ).toMatchObject({ kind: 'delta' })
    expect(merger.merge('env', { ...snapshot, revision: 3, epoch: 'new' })).toEqual({
      kind: 'delta',
      rows: [
        {
          hostKind: 'relay',
          launchMode: 'typed',
          attestedRuns: 1,
          noEvidence: 1,
          titleOnly: 0,
          identityNull: 1,
          ambiguousTopRank: 0
        }
      ],
      candidateCoverage: []
    })
    expect(
      merger.merge('env', {
        epoch: 'new',
        revision: 4,
        rows: [['relay', 'typed', 2, 1, 0, 1, 0] as const]
      })
    ).toMatchObject({ kind: 'delta' })
  })

  it('fail-closes cumulative counter regressions without moving the baseline backward', () => {
    const merger = new PaneAgentIdentityRelaySnapshotMerger()
    const row = ['relay', 'typed', 5, 1, 0, 1, 0] as const
    expect(merger.merge('env', { epoch: 'e', revision: 1, rows: [row] })).toMatchObject({
      kind: 'baseline'
    })
    expect(
      merger.merge('env', {
        epoch: 'e',
        revision: 2,
        rows: [['relay', 'typed', 4, 1, 0, 1, 0]]
      })
    ).toEqual({ kind: 'failed-closed', reason: 'counter-regressed' })
    expect(
      merger.merge('env', {
        epoch: 'e',
        revision: 3,
        rows: [['relay', 'typed', 6, 1, 0, 1, 0]]
      })
    ).toEqual({ kind: 'failed-closed', reason: 'counter-regressed' })
  })

  it('merges candidate coverage as a cumulative delta and fail-closes regressions', () => {
    const merger = new PaneAgentIdentityRelaySnapshotMerger()
    const baseline = {
      epoch: 'e',
      revision: 1,
      rows: [],
      candidateCoverage: [['relay', 2] as const]
    }
    expect(merger.merge('env', baseline)).toMatchObject({
      kind: 'baseline',
      rows: [],
      candidateCoverage: [{ hostKind: 'relay', exposures: 2 }]
    })
    expect(
      merger.merge('env', {
        ...baseline,
        revision: 2,
        candidateCoverage: [['relay', 5] as const]
      })
    ).toEqual({
      kind: 'delta',
      rows: [],
      candidateCoverage: [{ hostKind: 'relay', exposures: 3 }]
    })
    expect(
      merger.merge('env', {
        ...baseline,
        revision: 3,
        candidateCoverage: [['relay', 4] as const]
      })
    ).toEqual({ kind: 'failed-closed', reason: 'counter-regressed' })
  })

  it('strictly validates privacy-reduced snapshots and optional candidate coverage', () => {
    const snapshot = {
      epoch: 'e',
      revision: 1,
      rows: [['relay', 'typed', 1, 0, 0, 0, 0] as const],
      candidateCoverage: [['ssh', 1] as const]
    }
    expect(isPaneAgentIdentityAvailabilitySnapshot(snapshot)).toBe(true)
    expect(
      isPaneAgentIdentityAvailabilitySnapshot({ ...snapshot, rawTitle: 'private title' })
    ).toBe(false)
    expect(
      isPaneAgentIdentityAvailabilitySnapshot({
        ...snapshot,
        candidateCoverage: [['ssh', 1, '/private']]
      })
    ).toBe(false)
    expect(
      isPaneAgentIdentityAvailabilitySnapshot({
        ...snapshot,
        rows: [['relay', 'typed', 1, 2, 0, 0, 0]]
      })
    ).toBe(false)
  })

  it('accepts only bounded enum-and-count telemetry rows', () => {
    const valid = {
      rows: [
        {
          kind: 'coverage' as const,
          host_kind: 'relay' as const,
          reason: 'counter_regressed' as const,
          count: 1
        }
      ]
    }
    expect(eventSchemas.pane_agent_identity_availability.safeParse(valid).success).toBe(true)
    expect(
      eventSchemas.pane_agent_identity_availability.safeParse({
        rows: [{ ...valid.rows[0], title: 'private' }]
      }).success
    ).toBe(false)
    expect(
      eventSchemas.pane_agent_identity_availability.safeParse({
        rows: [{ ...valid.rows[0], count: '1' }]
      }).success
    ).toBe(false)
  })

  it('retains bounded command edit semantics and discards input after classification', () => {
    const tracker = new ManualAgentCommandTracker()
    expect(tracker.ingest('codex\r')).toEqual(['codex'])
    expect(tracker.ingest('cod\u0008dex\r')).toEqual(['codex'])
    expect(tracker.ingest('claude\rcodex\r')).toEqual(['claude', 'codex'])

    tracker.ingest('x'.repeat(MANUAL_AGENT_COMMAND_MAX_CHARS))
    expect(tracker.ingest('y\rcodex\r')).toEqual([])
    expect(tracker.ingest('\r')).toEqual([])
    expect(tracker.ingest('codex\r')).toEqual([])
    tracker.ingest('\x15')
    expect(tracker.ingest('codex\r')).toEqual(['codex'])
  })

  it('only clears a pending command when cancelling suspended inference', () => {
    const tracker = new ManualAgentCommandTracker()
    tracker.ingest('co')
    tracker.cancelSuspendedInference()
    expect(tracker.ingest('dex\r')).toEqual(['codex'])

    tracker.ingest('x'.repeat(MANUAL_AGENT_COMMAND_MAX_CHARS + 1))
    tracker.cancelSuspendedInference()
    expect(tracker.ingest('claude\r')).toEqual(['claude'])
  })
})
