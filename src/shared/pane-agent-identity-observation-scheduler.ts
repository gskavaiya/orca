import type { PaneAgentIdentityHostKind } from './pane-agent-identity-evidence'

export const RUN_SETTLE_MS = 5_000
export const TITLE_CANDIDATE_WINDOW_MS = 30_000
export const MAX_PENDING_IDENTITY_OBSERVATIONS = 4_096
export const MAX_LIVE_FINALIZED_RUN_KEYS = 4_096

export type PaneAgentIdentityObservationSchedulerDeps = {
  now?: () => number
  onRunFreeze: (key: string) => void
  onTitleCandidateFreeze: (hostKind: PaneAgentIdentityHostKind, key: string) => void
  onFinalizedOverflow?: (
    kind: 'run' | 'title-candidate',
    hostKind: PaneAgentIdentityHostKind | undefined,
    key: string
  ) => void
}

/** Event-driven settle/deadline scheduler; it never probes or polls a host. */
export class PaneAgentIdentityObservationScheduler {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly candidates = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly finalized = new Set<string>()
  private readonly now: () => number
  constructor(private readonly deps: PaneAgentIdentityObservationSchedulerDeps) {
    this.now = deps.now ?? Date.now
  }
  scheduleRun(key: string, settleMs = RUN_SETTLE_MS): boolean {
    if (
      this.pending.size + this.candidates.size >= MAX_PENDING_IDENTITY_OBSERVATIONS &&
      !this.pending.has(key)
    ) {
      return false
    }
    if (this.finalized.has(key)) {
      return false
    }
    this.cancelRun(key)
    const timer = setTimeout(
      () => {
        if (!this.freezeRun(key)) {
          this.deps.onFinalizedOverflow?.('run', undefined, key)
        }
      },
      Math.max(0, settleMs)
    )
    timer.unref?.()
    this.pending.set(key, timer)
    return true
  }
  scheduleTitleCandidate(
    key: string,
    hostKind: PaneAgentIdentityHostKind,
    windowMs = TITLE_CANDIDATE_WINDOW_MS
  ): boolean {
    if (
      this.pending.size + this.candidates.size >= MAX_PENDING_IDENTITY_OBSERVATIONS &&
      !this.candidates.has(key)
    ) {
      return false
    }
    if (this.candidates.has(key)) {
      return true
    }
    const timer = setTimeout(
      () => {
        if (!this.freezeTitleCandidate(key, hostKind)) {
          this.deps.onFinalizedOverflow?.('title-candidate', hostKind, key)
        }
      },
      Math.max(0, windowMs)
    )
    timer.unref?.()
    this.candidates.set(key, timer)
    return true
  }
  attestRun(key: string): boolean {
    return this.scheduleRun(key)
  }
  freezeRun(key: string): boolean {
    if (this.finalized.has(key)) {
      return false
    }
    if (this.finalized.size >= MAX_LIVE_FINALIZED_RUN_KEYS) {
      this.cancelRun(key)
      return false
    }
    this.cancelRun(key)
    this.finalized.add(key)
    this.deps.onRunFreeze(key)
    return true
  }
  freezeTitleCandidate(key: string, hostKind: PaneAgentIdentityHostKind): boolean {
    if (this.finalized.has(key)) {
      return false
    }
    if (this.finalized.size >= MAX_LIVE_FINALIZED_RUN_KEYS) {
      this.cancelCandidate(key)
      return false
    }
    this.cancelCandidate(key)
    this.finalized.add(key)
    this.deps.onTitleCandidateFreeze(hostKind, key)
    return true
  }
  cancelCandidate(key: string): void {
    const timer = this.candidates.get(key)
    if (timer) {
      clearTimeout(timer)
    }
    this.candidates.delete(key)
  }
  cancelRun(key: string): void {
    const timer = this.pending.get(key)
    if (timer) {
      clearTimeout(timer)
    }
    this.pending.delete(key)
  }
  exitOrRebind(key: string): void {
    this.cancelRun(key)
    this.cancelCandidate(key)
    this.finalized.delete(key)
  }
  shutdown(): void {
    for (const timer of this.pending.values()) {
      clearTimeout(timer)
    }
    for (const timer of this.candidates.values()) {
      clearTimeout(timer)
    }
    this.pending.clear()
    this.candidates.clear()
    this.finalized.clear()
  }
  isPendingRun(key: string): boolean {
    return this.pending.has(key)
  }
  isPendingCandidate(key: string): boolean {
    return this.candidates.has(key)
  }
  get clock(): number {
    return this.now()
  }
}
