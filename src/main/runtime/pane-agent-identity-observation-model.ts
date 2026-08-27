import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { TuiAgent } from '../../shared/tui-agent'
import type {
  PaneAgentIdentityEvidenceFact,
  PaneAgentIdentityHostKind,
  PaneAgentIdentityLaunchMode
} from '../../shared/pane-agent-identity-evidence'
import type {
  PaneAgentEvidenceSource,
  PaneAgentRunKey
} from '../../shared/pane-agent-identity-resolver'

export type ActiveRun = {
  key: string
  ptyId: string
  run: PaneAgentRunKey
  launchMode: PaneAgentIdentityLaunchMode
  owner: TuiAgent
  hostKinds: readonly PaneAgentIdentityHostKind[]
  factsByHostKind: Map<PaneAgentIdentityHostKind, PaneAgentIdentityEvidenceFact[]>
}

export type Candidate = {
  key: string
  ptyId: string
  hostKind: PaneAgentIdentityHostKind
}

export type PtyObservationState = {
  incarnationId: PtyIncarnationId | null
  ordinal: number
  lastAttestationId: string | null
  activeRun: ActiveRun | null
  finalizedRunKey: string | null
  candidate: Candidate | null
  finalizedCandidateKey: string | null
}

export type EvidenceObservation =
  | {
      source: 'process'
      agent: TuiAgent
      processProvenance: 'execution-host' | 'distro-origin' | 'target-origin'
    }
  | {
      source: Exclude<
        PaneAgentEvidenceSource,
        'launch' | 'sleeping-session' | 'sibling' | 'process'
      >
      agent: TuiAgent
      processProvenance?: never
    }

export const uniqueHostKinds = (
  hostKinds: readonly PaneAgentIdentityHostKind[]
): PaneAgentIdentityHostKind[] => [...new Set(hostKinds)]

export function appendEvidenceToActiveRun(
  activeRun: ActiveRun,
  evidence: EvidenceObservation
): boolean {
  for (const hostKind of activeRun.hostKinds) {
    if (!evidenceBelongsToHost(hostKind, evidence)) {
      continue
    }
    const facts = activeRun.factsByHostKind.get(hostKind)
    if (!facts) {
      continue
    }
    const fact: PaneAgentIdentityEvidenceFact =
      evidence.source === 'process'
        ? {
            source: evidence.source,
            agent: evidence.agent,
            run: activeRun.run,
            executionHostProvenance: evidence.processProvenance
          }
        : { source: evidence.source, agent: evidence.agent, run: activeRun.run }
    if (
      !facts.some((existing) => existing.source === fact.source && existing.agent === fact.agent)
    ) {
      facts.push(fact)
    }
  }
  return true
}

export function titleHostKind(
  hostKinds: readonly PaneAgentIdentityHostKind[]
): PaneAgentIdentityHostKind {
  if (hostKinds.includes('ssh')) {
    return 'ssh'
  }
  if (hostKinds.includes('wsl-distro')) {
    return 'wsl-distro'
  }
  if (hostKinds.includes('relay')) {
    return 'relay'
  }
  return 'native'
}

function evidenceBelongsToHost(
  hostKind: PaneAgentIdentityHostKind,
  evidence: EvidenceObservation
): boolean {
  if (hostKind === 'wsl-host') {
    return false
  }
  if (evidence.source !== 'process') {
    return true
  }
  return (
    (hostKind === 'native' && evidence.processProvenance === 'execution-host') ||
    (hostKind === 'wsl-distro' && evidence.processProvenance === 'distro-origin') ||
    (hostKind === 'ssh' && evidence.processProvenance === 'target-origin') ||
    hostKind === 'relay'
  )
}
