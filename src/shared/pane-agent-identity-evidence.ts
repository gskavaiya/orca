import {
  PANE_AGENT_EVIDENCE_SOURCES,
  type PaneAgentEvidence,
  type PaneAgentEvidenceSource,
  type PaneAgentRunKey,
  resolvePaneAgentIdentity
} from './pane-agent-identity-resolver'
import { resolveCompatibleAgentTypeForOwner } from './agent-title-owner'
import type { TuiAgent } from './tui-agent'

export type PaneAgentIdentityHostKind = 'native' | 'wsl-host' | 'wsl-distro' | 'ssh' | 'relay'
export type PaneAgentIdentityLaunchMode = 'typed' | 'orca-launch' | 'resume'

type PaneAgentIdentityNonProcessFact = Omit<PaneAgentEvidence<TuiAgent>, 'source'> & {
  source: Exclude<PaneAgentEvidenceSource, 'process'>
  executionHostProvenance?: never
}
type PaneAgentIdentityProcessFact = Omit<PaneAgentEvidence<TuiAgent>, 'source'> & {
  source: 'process'
  /** Process observations must identify the execution host that produced them. */
  executionHostProvenance: 'execution-host' | 'distro-origin' | 'target-origin'
}
export type PaneAgentIdentityEvidenceFact =
  | PaneAgentIdentityNonProcessFact
  | PaneAgentIdentityProcessFact

export type PaneAgentIdentityOwnerFact = {
  agent: TuiAgent
  run: PaneAgentRunKey
}

export type PaneAgentIdentityEvidenceInput = {
  facts: readonly PaneAgentIdentityEvidenceFact[]
  currentRun?: PaneAgentRunKey
  owner?: PaneAgentIdentityOwnerFact
}

/** Stable encoding. Do not derive telemetry bits from array indexes. */
export const PANE_AGENT_IDENTITY_SOURCE_BITS: Readonly<Record<PaneAgentEvidenceSource, number>> = {
  'live-hook': 1,
  process: 2,
  launch: 4,
  'completed-hook': 8,
  'sleeping-session': 16,
  sibling: 32,
  title: 64
}

export type PaneAgentIdentityEvidence = {
  evidence: readonly PaneAgentEvidence<TuiAgent>[]
  resolvedAgent: TuiAgent | null
  sourceMask: number
  identityNull: boolean
  ambiguousTopRank: boolean
}

/** Assemble already-redacted authority facts; raw titles/commands never enter this layer. */
export function assemblePaneAgentIdentityEvidence(
  input: PaneAgentIdentityEvidenceInput
): PaneAgentIdentityEvidence {
  const evidence = input.facts
    .filter((fact) => {
      if (fact.source === 'process' && fact.executionHostProvenance === undefined) {
        return false
      }
      if (fact.source === 'sibling') {
        return false
      }
      if (
        input.currentRun &&
        fact.run?.authorityId === input.currentRun.authorityId &&
        fact.run.incarnation !== input.currentRun.incarnation
      ) {
        return false
      }
      return true
    })
    .sort(
      (left, right) =>
        PANE_AGENT_EVIDENCE_SOURCES.indexOf(left.source) -
        PANE_AGENT_EVIDENCE_SOURCES.indexOf(right.source)
    )
  const resolved = resolvePaneAgentIdentity({
    evidence,
    currentRun: input.currentRun
  })
  let resolvedAgent = resolved.agent
  if (
    resolvedAgent &&
    input.owner &&
    input.currentRun &&
    input.owner.run.authorityId === input.currentRun.authorityId &&
    input.owner.run.incarnation === input.currentRun.incarnation
  ) {
    // Owner compatibility is deliberately same-run only; incomparable owners do not rewrite.
    if (
      input.owner.agent !== resolvedAgent &&
      resolveCompatibleAgentTypeForOwner(resolvedAgent, input.owner.agent) === input.owner.agent
    ) {
      resolvedAgent = input.owner.agent
    }
  }
  return {
    evidence,
    resolvedAgent,
    sourceMask: evidence.reduce(
      (mask, item) => mask | PANE_AGENT_IDENTITY_SOURCE_BITS[item.source],
      0
    ),
    identityNull: resolved.agent === null,
    ambiguousTopRank: resolved.ambiguousAt !== undefined
  }
}

export type PaneAgentIdentityAvailability = {
  hostKind: PaneAgentIdentityHostKind
  launchMode: PaneAgentIdentityLaunchMode
  sourceMask: number
  identityNull: boolean
  ambiguousTopRank: boolean
}

export function reducePaneAgentIdentityAvailability(
  hostKind: PaneAgentIdentityHostKind,
  launchMode: PaneAgentIdentityLaunchMode,
  input: PaneAgentIdentityEvidenceInput
): PaneAgentIdentityAvailability {
  const assembled = assemblePaneAgentIdentityEvidence(input)
  return {
    hostKind,
    launchMode,
    sourceMask: assembled.sourceMask,
    identityNull: assembled.identityNull,
    ambiguousTopRank: assembled.ambiguousTopRank
  }
}

export const PANE_AGENT_TITLE_SOURCE_BIT = PANE_AGENT_IDENTITY_SOURCE_BITS.title
export const PANE_AGENT_IDENTITY_SOURCE_ORDER = PANE_AGENT_EVIDENCE_SOURCES
