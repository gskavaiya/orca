import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaneAgentIdentityCensus } from './pane-agent-identity-census'

describe('PaneAgentIdentityCensus', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('schedules relay-only deltas and preserves relay coverage host attribution', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const census = new PaneAgentIdentityCensus(emit)
    const row = ['relay', 'typed', 1, 0, 0, 0, 0] as const

    census.ingestRelaySnapshot('env', { epoch: 'e', revision: 1, rows: [row] })
    vi.advanceTimersByTime(300_000)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'coverage',
          host_kind: 'relay',
          reason: 'baseline',
          count: 1
        })
      ])
    )
    emit.mockClear()

    census.ingestRelaySnapshot('env', {
      epoch: 'e',
      revision: 2,
      rows: [['relay', 'typed', 2, 0, 0, 0, 0]],
      candidateCoverage: [['relay', 2]]
    })
    expect(emit).not.toHaveBeenCalled()
    expect(census.snapshot().candidateCoverage).toBeUndefined()

    vi.advanceTimersByTime(300_000)

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'aggregate',
          host_kind: 'relay',
          attested_runs: 1
        }),
        expect.objectContaining({
          kind: 'coverage',
          host_kind: 'relay',
          reason: 'snapshot',
          count: 1
        }),
        expect.objectContaining({
          kind: 'coverage',
          host_kind: 'relay',
          reason: 'candidate',
          count: 2
        })
      ])
    )
    census.shutdown()
  })
})
