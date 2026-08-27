import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneAgentIdentityAvailability } from '../../shared/pane-agent-identity-evidence'
import { MAX_LIVE_FINALIZED_RUN_KEYS } from '../../shared/pane-agent-identity-availability'
import { PaneAgentIdentityObservationAuthority } from './pane-agent-identity-observation-authority'

function createHarness() {
  const records: PaneAgentIdentityAvailability[] = []
  const coverage: { hostKind: string; reason: string; amount: number }[] = []
  const authority = new PaneAgentIdentityObservationAuthority('authority', {
    record: (row) => records.push(row),
    addCoverage: (hostKind, reason, amount = 1) => coverage.push({ hostKind, reason, amount })
  })
  return { authority, records, coverage }
}

describe('PaneAgentIdentityObservationAuthority', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles once after five seconds and dedupes the finalized attestation', () => {
    vi.useFakeTimers()
    const { authority, records } = createHarness()
    const context = { ptyId: 'pty', incarnationId: 'inc-1', hostKinds: ['native'] as const }

    expect(authority.attestRun(context, 'typed', 'codex', 'typed:1')).toBe(true)
    vi.advanceTimersByTime(4_999)
    expect(records).toEqual([])
    vi.advanceTimersByTime(1)
    expect(records).toEqual([
      expect.objectContaining({ hostKind: 'native', launchMode: 'typed', sourceMask: 4 })
    ])

    expect(authority.attestRun(context, 'typed', 'codex', 'typed:1')).toBe(true)
    vi.advanceTimersByTime(5_000)
    expect(records).toHaveLength(1)

    expect(authority.attestRun(context, 'typed', 'claude', 'typed:2')).toBe(true)
    vi.advanceTimersByTime(5_000)
    expect(records).toHaveLength(2)
    authority.shutdown()
  })

  it('publishes paired WSL facts with execution evidence only on the distro view', () => {
    vi.useFakeTimers()
    const { authority, records } = createHarness()
    const context = {
      ptyId: 'pty',
      incarnationId: 'inc-1',
      hostKinds: ['wsl-host', 'wsl-distro'] as const
    }
    authority.attestRun(context, 'orca-launch', 'codex', 'launch:1')
    authority.observeEvidence(context, {
      source: 'process',
      agent: 'codex',
      processProvenance: 'distro-origin'
    })
    authority.observeEvidence(context, { source: 'live-hook', agent: 'codex' })
    authority.observeTitle(context, 'codex')

    vi.advanceTimersByTime(5_000)

    expect(records).toEqual([
      expect.objectContaining({ hostKind: 'wsl-host', sourceMask: 4 }),
      expect.objectContaining({ hostKind: 'wsl-distro', sourceMask: 71 })
    ])
    authority.shutdown()
  })

  it('freezes pending runs immediately on exit and truncates only live windows on shutdown', () => {
    vi.useFakeTimers()
    const { authority, records, coverage } = createHarness()
    const first = { ptyId: 'pty-1', incarnationId: 'inc-1', hostKinds: ['ssh'] as const }
    const second = { ptyId: 'pty-2', incarnationId: 'inc-1', hostKinds: ['native'] as const }
    authority.attestRun(first, 'resume', 'claude', 'resume:1')
    authority.exitOrRebind(first.ptyId, first.incarnationId)
    expect(records).toEqual([
      expect.objectContaining({ hostKind: 'ssh', launchMode: 'resume', sourceMask: 20 })
    ])

    authority.attestRun(second, 'typed', 'codex', 'typed:1')
    authority.shutdown()
    expect(coverage).toContainEqual({ hostKind: 'native', reason: 'truncated', amount: 1 })
    vi.advanceTimersByTime(5_000)
    expect(records).toHaveLength(1)
  })

  it('records a title candidate only after its authority window and cancels it on attestation', () => {
    vi.useFakeTimers()
    const { authority, coverage } = createHarness()
    const context = { ptyId: 'pty', incarnationId: 'inc-1', hostKinds: ['ssh'] as const }
    authority.observeTitle(context, 'codex')
    vi.advanceTimersByTime(29_999)
    expect(coverage).toEqual([])
    vi.advanceTimersByTime(1)
    expect(coverage).toEqual([{ hostKind: 'ssh', reason: 'candidate', amount: 1 }])

    authority.exitOrRebind(context.ptyId, context.incarnationId)
    authority.observeTitle(context, 'codex')
    authority.attestRun(context, 'typed', 'codex', 'typed:1')
    vi.advanceTimersByTime(30_000)
    expect(coverage).toHaveLength(1)

    authority.observeTitle(context, 'codex')
    vi.advanceTimersByTime(30_000)
    expect(coverage).toHaveLength(1)
    authority.shutdown()
  })

  it('releases a title candidate after the finalized-key cap rejects it', () => {
    vi.useFakeTimers()
    const { authority, coverage } = createHarness()
    for (let index = 0; index < MAX_LIVE_FINALIZED_RUN_KEYS; index += 1) {
      authority.attestRun(
        { ptyId: `run-${index}`, incarnationId: 'inc-1', hostKinds: ['native'] },
        'typed',
        'codex',
        `typed:${index}`
      )
    }
    vi.advanceTimersByTime(5_000)

    const candidate = {
      ptyId: 'candidate',
      incarnationId: 'inc-1',
      hostKinds: ['native'] as const
    }
    authority.observeTitle(candidate, 'codex')
    vi.advanceTimersByTime(30_000)
    expect(coverage).toContainEqual({ hostKind: 'native', reason: 'overflow', amount: 1 })

    authority.observeTitle(candidate, 'codex')
    vi.advanceTimersByTime(30_000)
    authority.shutdown()
    expect(coverage).toEqual([{ hostKind: 'native', reason: 'overflow', amount: 1 }])
  })

  it('tombstones a title candidate when the pending-window cap rejects it', () => {
    vi.useFakeTimers()
    const { authority, coverage } = createHarness()
    for (let index = 0; index < MAX_LIVE_FINALIZED_RUN_KEYS; index += 1) {
      authority.attestRun(
        { ptyId: `run-${index}`, incarnationId: 'inc-1', hostKinds: ['native'] },
        'typed',
        'codex',
        `typed:${index}`
      )
    }

    const candidate = {
      ptyId: 'candidate',
      incarnationId: 'inc-1',
      hostKinds: ['native'] as const
    }
    authority.observeTitle(candidate, 'codex')
    authority.observeTitle(candidate, 'codex')
    expect(coverage).toEqual([{ hostKind: 'native', reason: 'overflow', amount: 1 }])
    authority.shutdown()
  })
})
