import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  PaneAgentIdentityObservationScheduler,
  type PaneAgentIdentityObservationSchedulerDeps
} from '../../shared/pane-agent-identity-availability'
import {
  reducePaneAgentIdentityAvailability,
  type PaneAgentIdentityAvailability,
  type PaneAgentIdentityEvidenceFact,
  type PaneAgentIdentityHostKind,
  type PaneAgentIdentityLaunchMode
} from '../../shared/pane-agent-identity-evidence'
import type { PaneAgentRunKey } from '../../shared/pane-agent-identity-resolver'
import {
  appendEvidenceToActiveRun,
  titleHostKind,
  uniqueHostKinds,
  type ActiveRun,
  type Candidate,
  type EvidenceObservation,
  type PtyObservationState
} from './pane-agent-identity-observation-model'

type CensusCoverageReason = 'candidate' | 'overflow' | 'truncated'

export type PaneAgentIdentityObservationSink = {
  record(observation: PaneAgentIdentityAvailability): void
  addCoverage(
    hostKind: PaneAgentIdentityHostKind,
    reason: CensusCoverageReason,
    amount?: number
  ): void
}

export type PaneAgentIdentityPtyContext = {
  ptyId: string
  incarnationId: PtyIncarnationId | null
  hostKinds: readonly PaneAgentIdentityHostKind[]
}

/** Owns run/candidate windows and reduces authority facts before they reach a sink. */
export class PaneAgentIdentityObservationAuthority {
  private readonly states = new Map<string, PtyObservationState>()
  private readonly runsByKey = new Map<string, ActiveRun>()
  private readonly candidatesByKey = new Map<string, Candidate>()
  private readonly scheduler: PaneAgentIdentityObservationScheduler

  constructor(
    private readonly authorityId: string,
    private readonly sink: PaneAgentIdentityObservationSink,
    schedulerDeps: Pick<PaneAgentIdentityObservationSchedulerDeps, 'now'> = {}
  ) {
    this.scheduler = new PaneAgentIdentityObservationScheduler({
      ...schedulerDeps,
      onRunFreeze: (key) => this.freezeRun(key),
      onTitleCandidateFreeze: (hostKind, key) => this.freezeCandidate(hostKind, key),
      onFinalizedOverflow: (kind, hostKind, key) =>
        this.recordFinalizedOverflow(kind, hostKind, key)
    })
  }

  attestRun(
    context: PaneAgentIdentityPtyContext,
    launchMode: PaneAgentIdentityLaunchMode,
    owner: TuiAgent,
    attestationId: string
  ): boolean {
    const state = this.getState(context)
    if (state.lastAttestationId === attestationId) {
      return true
    }
    if (state.activeRun) {
      const previousRun = state.activeRun
      if (!this.scheduler.freezeRun(previousRun.key)) {
        for (const hostKind of previousRun.hostKinds) {
          this.sink.addCoverage(hostKind, 'overflow')
        }
        this.runsByKey.delete(previousRun.key)
        state.activeRun = null
      }
    }
    if (state.candidate) {
      this.scheduler.cancelCandidate(state.candidate.key)
      this.scheduler.exitOrRebind(state.candidate.key)
      this.candidatesByKey.delete(state.candidate.key)
      state.candidate = null
    }
    if (state.finalizedRunKey) {
      this.scheduler.exitOrRebind(state.finalizedRunKey)
      state.finalizedRunKey = null
    }
    if (state.finalizedCandidateKey) {
      this.scheduler.exitOrRebind(state.finalizedCandidateKey)
      state.finalizedCandidateKey = null
    }
    state.ordinal += 1
    const run: PaneAgentRunKey = {
      authorityId: `${this.authorityId}:${context.ptyId}:${context.incarnationId ?? 'unknown'}`,
      incarnation: state.ordinal
    }
    const key = `${run.authorityId}:${run.incarnation}`
    const hostKinds = uniqueHostKinds(context.hostKinds)
    const factsByHostKind = new Map<PaneAgentIdentityHostKind, PaneAgentIdentityEvidenceFact[]>()
    for (const hostKind of hostKinds) {
      const facts: PaneAgentIdentityEvidenceFact[] = []
      if (launchMode === 'orca-launch') {
        facts.push({ source: 'launch', agent: owner, run })
      }
      if (launchMode === 'resume') {
        facts.push({ source: 'sleeping-session', agent: owner, run })
      }
      factsByHostKind.set(hostKind, facts)
    }
    const activeRun: ActiveRun = {
      key,
      ptyId: context.ptyId,
      run,
      launchMode,
      owner,
      hostKinds,
      factsByHostKind
    }
    state.lastAttestationId = attestationId
    state.activeRun = activeRun
    this.runsByKey.set(key, activeRun)
    if (this.scheduler.attestRun(key)) {
      return true
    }
    this.runsByKey.delete(key)
    state.activeRun = null
    for (const hostKind of hostKinds) {
      this.sink.addCoverage(hostKind, 'overflow')
    }
    return false
  }

  observeEvidence(context: PaneAgentIdentityPtyContext, evidence: EvidenceObservation): boolean {
    const state = this.states.get(context.ptyId)
    const activeRun = state?.activeRun
    if (!state || state.incarnationId !== context.incarnationId || !activeRun) {
      return false
    }
    return appendEvidenceToActiveRun(activeRun, evidence)
  }

  observeTitle(context: PaneAgentIdentityPtyContext, agent: TuiAgent): void {
    if (this.observeEvidence(context, { source: 'title', agent })) {
      return
    }
    const state = this.getState(context)
    if (state.ordinal > 0 || state.candidate || state.finalizedCandidateKey) {
      return
    }
    const hostKind = titleHostKind(context.hostKinds)
    const candidate = {
      key: `${this.authorityId}:${context.ptyId}:${context.incarnationId ?? 'unknown'}:candidate`,
      ptyId: context.ptyId,
      hostKind,
      agent
    }
    if (!this.scheduler.scheduleTitleCandidate(candidate.key, candidate.hostKind)) {
      this.sink.addCoverage(hostKind, 'overflow')
      state.finalizedCandidateKey = candidate.key
      return
    }
    state.candidate = candidate
    this.candidatesByKey.set(candidate.key, candidate)
  }

  exitOrRebind(ptyId: string, incarnationId?: PtyIncarnationId | null): void {
    const state = this.states.get(ptyId)
    if (!state || (incarnationId !== undefined && state.incarnationId !== incarnationId)) {
      return
    }
    if (state.activeRun && this.scheduler.isPendingRun(state.activeRun.key)) {
      if (!this.scheduler.freezeRun(state.activeRun.key)) {
        for (const hostKind of state.activeRun.hostKinds) {
          this.sink.addCoverage(hostKind, 'overflow')
        }
      }
    }
    if (state.candidate && this.scheduler.isPendingCandidate(state.candidate.key)) {
      if (!this.scheduler.freezeTitleCandidate(state.candidate.key, state.candidate.hostKind)) {
        this.sink.addCoverage(state.candidate.hostKind, 'overflow')
      }
    }
    if (state.activeRun) {
      this.scheduler.exitOrRebind(state.activeRun.key)
      this.runsByKey.delete(state.activeRun.key)
    }
    if (state.finalizedRunKey) {
      this.scheduler.exitOrRebind(state.finalizedRunKey)
    }
    if (state.candidate) {
      this.scheduler.exitOrRebind(state.candidate.key)
      this.candidatesByKey.delete(state.candidate.key)
    }
    if (state.finalizedCandidateKey) {
      this.scheduler.exitOrRebind(state.finalizedCandidateKey)
    }
    this.states.delete(ptyId)
  }

  shutdown(): void {
    for (const state of this.states.values()) {
      if (state.activeRun && this.scheduler.isPendingRun(state.activeRun.key)) {
        for (const hostKind of state.activeRun.hostKinds) {
          this.sink.addCoverage(hostKind, 'truncated')
        }
      }
      if (state.candidate && this.scheduler.isPendingCandidate(state.candidate.key)) {
        this.sink.addCoverage(state.candidate.hostKind, 'truncated')
      }
    }
    this.scheduler.shutdown()
    this.states.clear()
    this.runsByKey.clear()
    this.candidatesByKey.clear()
  }

  private getState(context: PaneAgentIdentityPtyContext): PtyObservationState {
    const existing = this.states.get(context.ptyId)
    if (existing && existing.incarnationId === context.incarnationId) {
      return existing
    }
    if (existing) {
      this.exitOrRebind(context.ptyId, existing.incarnationId)
    }
    const state: PtyObservationState = {
      incarnationId: context.incarnationId,
      ordinal: 0,
      lastAttestationId: null,
      activeRun: null,
      finalizedRunKey: null,
      candidate: null,
      finalizedCandidateKey: null
    }
    this.states.set(context.ptyId, state)
    return state
  }

  private freezeRun(key: string): void {
    const run = this.runsByKey.get(key)
    if (!run) {
      return
    }
    for (const hostKind of run.hostKinds) {
      this.sink.record(
        reducePaneAgentIdentityAvailability(hostKind, run.launchMode, {
          facts: run.factsByHostKind.get(hostKind) ?? [],
          currentRun: run.run,
          owner: { agent: run.owner, run: run.run }
        })
      )
    }
    this.runsByKey.delete(key)
    const state = this.states.get(run.ptyId)
    if (state?.activeRun?.key === key) {
      state.activeRun = null
      state.finalizedRunKey = key
    }
  }

  private freezeCandidate(hostKind: PaneAgentIdentityHostKind, key: string): void {
    const candidate = this.candidatesByKey.get(key)
    this.candidatesByKey.delete(key)
    const candidateState = candidate ? this.states.get(candidate.ptyId) : undefined
    if (candidate) {
      this.sink.record(
        reducePaneAgentIdentityAvailability(candidate.hostKind, 'typed', {
          facts: [{ source: 'title', agent: candidate.agent }]
        })
      )
    } else {
      this.sink.addCoverage(hostKind, 'candidate')
    }
    if (candidateState) {
      candidateState.candidate = null
      candidateState.finalizedCandidateKey = key
    }
  }

  private recordFinalizedOverflow(
    kind: 'run' | 'title-candidate',
    hostKind: PaneAgentIdentityHostKind | undefined,
    key: string
  ): void {
    if (kind === 'title-candidate' && hostKind) {
      this.sink.addCoverage(hostKind, 'overflow')
      const candidate = this.candidatesByKey.get(key)
      this.candidatesByKey.delete(key)
      const state = candidate ? this.states.get(candidate.ptyId) : undefined
      if (state?.candidate?.key === key) {
        state.candidate = null
        state.finalizedCandidateKey = key
      }
      return
    }
    const run = this.runsByKey.get(key)
    if (!run) {
      return
    }
    for (const runHostKind of run.hostKinds) {
      this.sink.addCoverage(runHostKind, 'overflow')
    }
    this.runsByKey.delete(key)
    const state = this.states.get(run.ptyId)
    if (state?.activeRun?.key === key) {
      state.activeRun = null
    }
  }
}
