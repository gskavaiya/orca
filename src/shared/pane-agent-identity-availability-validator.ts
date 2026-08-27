import {
  PANE_AGENT_IDENTITY_MAX_COUNT,
  type PaneAgentIdentityAvailabilitySnapshot
} from './pane-agent-identity-availability'

export function isPaneAgentIdentityAvailabilitySnapshot(
  value: unknown
): value is PaneAgentIdentityAvailabilitySnapshot {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Record<string, unknown>
  const snapshotKeys = new Set(['epoch', 'revision', 'rows', 'candidateCoverage'])
  if (Object.keys(candidate).some((key) => !snapshotKeys.has(key))) {
    return false
  }
  if (
    typeof candidate.epoch !== 'string' ||
    candidate.epoch.length === 0 ||
    candidate.epoch.length > 128
  ) {
    return false
  }
  if (!Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 0) {
    return false
  }
  if (!Array.isArray(candidate.rows) || candidate.rows.length > 15) {
    return false
  }
  const rowKeys = new Set<string>()
  const rowsValid = candidate.rows.every((row) => {
    if (!Array.isArray(row) || row.length !== 7) {
      return false
    }
    const [hostKind, launchMode, attestedRuns, ...counters] = row
    if (
      !['native', 'wsl-host', 'wsl-distro', 'ssh', 'relay'].includes(hostKind as string) ||
      !['typed', 'orca-launch', 'resume'].includes(launchMode as string)
    ) {
      return false
    }
    const key = `${hostKind as string}:${launchMode as string}`
    if (rowKeys.has(key)) {
      return false
    }
    rowKeys.add(key)
    if (
      !Number.isSafeInteger(attestedRuns) ||
      (attestedRuns as number) < 1 ||
      (attestedRuns as number) > PANE_AGENT_IDENTITY_MAX_COUNT
    ) {
      return false
    }
    return counters.every(
      (count) =>
        Number.isSafeInteger(count) &&
        (count as number) >= 0 &&
        (count as number) <= (attestedRuns as number)
    )
  })
  if (!rowsValid) {
    return false
  }
  if (candidate.candidateCoverage === undefined) {
    return true
  }
  if (!Array.isArray(candidate.candidateCoverage) || candidate.candidateCoverage.length > 5) {
    return false
  }
  const coverageHosts = new Set<string>()
  return candidate.candidateCoverage.every((row) => {
    if (!Array.isArray(row) || row.length !== 2) {
      return false
    }
    const [hostKind, exposures] = row
    if (
      !['native', 'wsl-host', 'wsl-distro', 'ssh', 'relay'].includes(hostKind as string) ||
      !Number.isSafeInteger(exposures) ||
      (exposures as number) < 1 ||
      (exposures as number) > PANE_AGENT_IDENTITY_MAX_COUNT ||
      coverageHosts.has(hostKind as string)
    ) {
      return false
    }
    coverageHosts.add(hostKind as string)
    return true
  })
}
