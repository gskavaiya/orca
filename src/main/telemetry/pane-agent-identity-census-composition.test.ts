import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PaneAgentIdentityAuthoritySnapshot } from '../../shared/pane-agent-identity-availability'
import type {
  PaneAgentIdentityHostKind,
  PaneAgentIdentityLaunchMode
} from '../../shared/pane-agent-identity-evidence'
import { track } from './client'
import {
  createDesktopPaneAgentIdentityCensus,
  createHeadlessPaneAgentIdentityCensus
} from './pane-agent-identity-census-composition'

vi.mock('./client', () => ({ track: vi.fn() }))

describe('pane identity census composition', () => {
  it('constructs the desktop census as a telemetry emitter', () => {
    const census = createDesktopPaneAgentIdentityCensus()
    census.record({
      hostKind: 'native',
      launchMode: 'typed',
      sourceMask: 4,
      identityNull: false,
      ambiguousTopRank: false
    })
    census.flush()

    expect(track).toHaveBeenCalledWith('pane_agent_identity_availability', {
      rows: [expect.objectContaining({ kind: 'aggregate', host_kind: 'native' })]
    })
    census.shutdown()
  })

  it('constructs the headless census as one snapshot-only relay authority', () => {
    vi.mocked(track).mockClear()
    const census = createHeadlessPaneAgentIdentityCensus()
    census.record({
      hostKind: 'wsl-distro',
      launchMode: 'resume',
      sourceMask: 20,
      identityNull: false,
      ambiguousTopRank: false
    })
    census.flush()

    expect(census.snapshot().rows).toEqual([['relay', 'resume', 1, 0, 0, 0, 0]])
    expect(track).not.toHaveBeenCalled()
    census.shutdown()
  })

  it('keeps the maximum authority snapshot below the terminal-list wire budget', () => {
    const snapshot = new PaneAgentIdentityAuthoritySnapshot('e'.repeat(128))
    const hostKinds: PaneAgentIdentityHostKind[] = [
      'native',
      'wsl-host',
      'wsl-distro',
      'ssh',
      'relay'
    ]
    const launchModes: PaneAgentIdentityLaunchMode[] = ['typed', 'orca-launch', 'resume']
    for (const hostKind of hostKinds) {
      for (const launchMode of launchModes) {
        snapshot.record({
          hostKind,
          launchMode,
          sourceMask: 64,
          identityNull: true,
          ambiguousTopRank: true
        })
      }
      snapshot.recordCandidateCoverage(hostKind)
    }

    expect(Buffer.byteLength(JSON.stringify(snapshot.snapshot()), 'utf8')).toBeLessThan(2_048)
  })

  it('installs the census and primary hook facts in both production entry points', () => {
    const desktop = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
    const headless = readFileSync(resolve(process.cwd(), 'src/main/orcad/orcad-entry.ts'), 'utf8')

    expect(desktop).toContain(
      'const paneAgentIdentityCensus = isServeMode\n    ? createHeadlessPaneAgentIdentityCensus()\n    : createDesktopPaneAgentIdentityCensus()'
    )
    expect(headless).toContain(
      'const paneAgentIdentityCensus = createHeadlessPaneAgentIdentityCensus()'
    )
    for (const source of [desktop, headless]) {
      expect(source).toMatch(
        /new OrcaRuntimeService\([\s\S]*?\{[\s\S]*?paneAgentIdentityCensus[,\s]/
      )
    }
    expect(desktop).toContain('runtime?.observeAgentHookStatus(enriched)')
  })
})
