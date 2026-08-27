import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { track } from '../telemetry/client'
import { PaneAgentIdentityCensus } from '../telemetry/pane-agent-identity-census'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

async function availabilityRows(runtime: OrcaRuntimeService) {
  return ((await runtime.listTerminals()).agentIdentityAvailability?.rows ?? []).map((row) => ({
    hostKind: row[0],
    launchMode: row[1],
    attestedRuns: row[2],
    noEvidence: row[3],
    titleOnly: row[4],
    identityNull: row[5],
    ambiguousTopRank: row[6]
  }))
}

describe('runtime pane identity census wiring', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('publishes paired WSL typed views without a false native row', async () => {
    vi.useFakeTimers()
    vi.mocked(track).mockClear()
    const runtime = new OrcaRuntimeService(undefined, undefined, {
      paneAgentIdentityCensus: new PaneAgentIdentityCensus()
    })
    runtime.registerPty('pty-wsl', 'folder:/tmp', null, undefined, true)

    runtime.observeAcceptedPtyWrite('pty-wsl', 'codex\r')
    vi.advanceTimersByTime(5_000)

    expect(await availabilityRows(runtime)).toEqual([
      expect.objectContaining({ hostKind: 'wsl-host', launchMode: 'typed', attestedRuns: 1 }),
      expect.objectContaining({ hostKind: 'wsl-distro', launchMode: 'typed', attestedRuns: 1 })
    ])
    runtime.shutdownPaneAgentIdentityCensus()
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledWith('pane_agent_identity_availability', {
      rows: expect.arrayContaining([
        expect.objectContaining({ host_kind: 'wsl-host', attested_runs: 1 }),
        expect.objectContaining({ host_kind: 'wsl-distro', attested_runs: 1 })
      ])
    })
  })

  it('does not relabel a Windows-side WSL foreground read as distro process provenance', async () => {
    vi.useFakeTimers()
    const census = new PaneAgentIdentityCensus({ emit: null })
    const record = vi.spyOn(census, 'record')
    const runtime = new OrcaRuntimeService(undefined, undefined, {
      paneAgentIdentityCensus: census
    })
    runtime.registerPty('pty-wsl', 'folder:/tmp', null, undefined, true)
    runtime.setPtyController({ getForegroundProcess: async () => 'codex' } as never)
    runtime.observeAcceptedPtyWrite('pty-wsl', 'codex\r')
    await (
      runtime as unknown as {
        loadPtyForegroundAgentFromController: (ptyId: string) => Promise<boolean>
      }
    ).loadPtyForegroundAgentFromController('pty-wsl')
    vi.advanceTimersByTime(5_000)

    expect(record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ hostKind: 'wsl-host', sourceMask: 4 })
    )
    expect(record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ hostKind: 'wsl-distro', sourceMask: 4 })
    )
    expect(census.snapshot().rows).toEqual([
      ['wsl-host', 'typed', 1, 0, 0, 0, 0],
      ['wsl-distro', 'typed', 1, 0, 0, 0, 0]
    ])
    runtime.shutdownPaneAgentIdentityCensus(false)
  })

  it('requires same-incarnation SSH target corroboration', async () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    const binding = {
      tabId: '00000000-0000-4000-8000-000000000001',
      leafId: '00000000-0000-4000-8000-000000000002',
      incarnationId: 'incarnation-1'
    }
    runtime.registerPty('pty-ssh', 'folder:/tmp', 'ssh-1', binding)
    runtime.observeAcceptedPtyWrite('pty-ssh', 'codex\r')

    expect(runtime.corroborateSshTypedAgent('pty-ssh', 'claude')).toBe(false)
    expect(await availabilityRows(runtime)).toEqual([])

    runtime.registerPty('pty-ssh', 'folder:/tmp', 'ssh-1', {
      ...binding,
      incarnationId: 'incarnation-2'
    })
    expect(runtime.corroborateSshTypedAgent('pty-ssh', 'codex')).toBe(false)
    expect(await availabilityRows(runtime)).toEqual([])

    runtime.observeAcceptedPtyWrite('pty-ssh', 'codex\r')
    runtime.onPtyData(
      'pty-ssh',
      '\x1b]9999;{"state":"working","agentType":"codex"}\x07',
      Date.now()
    )
    vi.advanceTimersByTime(5_000)
    expect(await availabilityRows(runtime)).toEqual([
      expect.objectContaining({ hostKind: 'ssh', launchMode: 'typed', attestedRuns: 1 })
    ])
    runtime.shutdownPaneAgentIdentityCensus(false)
  })

  it('does not let a replayed SSH hook certify a typed run', async () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    const tabId = '00000000-0000-4000-8000-000000000001'
    const leafId = '00000000-0000-4000-8000-000000000002'
    runtime.registerPty('pty-ssh', 'folder:/tmp', 'ssh-1', {
      tabId,
      leafId,
      incarnationId: 'incarnation-1'
    })
    runtime.observeAcceptedPtyWrite('pty-ssh', 'codex\r')

    expect(
      runtime.observeAgentHookStatus({
        paneKey: `${tabId}:${leafId}`,
        connectionId: 'ssh-1',
        isReplay: true,
        payload: { state: 'working', agentType: 'codex' }
      })
    ).toBe(false)
    vi.advanceTimersByTime(5_000)
    expect(await availabilityRows(runtime)).toEqual([])
    runtime.shutdownPaneAgentIdentityCensus(false)
  })

  it('accepts live WSL-relayed hook evidence only for its local WSL pane', async () => {
    vi.useFakeTimers()
    const census = new PaneAgentIdentityCensus({ emit: null })
    const record = vi.spyOn(census, 'record')
    const runtime = new OrcaRuntimeService(undefined, undefined, {
      paneAgentIdentityCensus: census
    })
    const tabId = '00000000-0000-4000-8000-000000000001'
    const wslLeafId = '00000000-0000-4000-8000-000000000002'
    const nativeLeafId = '00000000-0000-4000-8000-000000000003'
    runtime.registerPty(
      'pty-wsl',
      'folder:/tmp',
      null,
      {
        tabId,
        leafId: wslLeafId,
        incarnationId: 'incarnation-1'
      },
      true
    )
    runtime.registerPty('pty-native', 'folder:/tmp', null, {
      tabId,
      leafId: nativeLeafId,
      incarnationId: 'incarnation-1'
    })
    runtime.observeAcceptedPtyWrite('pty-wsl', 'codex\r')
    runtime.observeAcceptedPtyWrite('pty-native', 'codex\r')

    expect(
      runtime.observeAgentHookStatus({
        paneKey: `${tabId}:${nativeLeafId}`,
        connectionId: 'wsl:LiveDistro',
        payload: { state: 'working', agentType: 'codex' }
      })
    ).toBe(false)
    expect(
      runtime.observeAgentHookStatus({
        paneKey: `${tabId}:${wslLeafId}`,
        connectionId: 'wsl:LiveDistro',
        payload: { state: 'working', agentType: 'codex' }
      })
    ).toBe(true)
    vi.advanceTimersByTime(5_000)

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ hostKind: 'wsl-distro', sourceMask: 5 })
    )
    runtime.shutdownPaneAgentIdentityCensus(false)
  })

  it('records launch and resume through renderer registration authority', async () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    const binding = {
      tabId: '00000000-0000-4000-8000-000000000001',
      leafId: '00000000-0000-4000-8000-000000000002',
      incarnationId: 'incarnation-1'
    }
    runtime.registerPty('pty-launch', 'folder:/tmp', null, {
      ...binding,
      agentLaunchAuthority: {
        launchToken: 'launch-token',
        launchAgent: 'codex',
        launchMode: 'orca-launch'
      }
    })
    runtime.registerPty('pty-resume', 'folder:/tmp', null, {
      ...binding,
      leafId: '00000000-0000-4000-8000-000000000003',
      agentLaunchAuthority: {
        launchToken: 'resume-token',
        launchAgent: 'claude',
        launchMode: 'resume'
      }
    })
    vi.advanceTimersByTime(5_000)

    expect(await availabilityRows(runtime)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostKind: 'native', launchMode: 'orca-launch', attestedRuns: 1 }),
        expect.objectContaining({ hostKind: 'native', launchMode: 'resume', attestedRuns: 1 })
      ])
    )
    runtime.shutdownPaneAgentIdentityCensus(false)
  })

  it('does not guess a launch mode for an unstructured legacy terminal create', async () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    vi.spyOn(
      runtime as unknown as {
        resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
      },
      'resolveTerminalWorkspaceLaunchScope'
    ).mockResolvedValue({
      id: 'folder:/tmp',
      path: '/tmp',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-legacy', incarnationId: 'incarnation-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal('id:folder:/tmp', {
      command: 'codex resume provider-session-1',
      launchAgent: 'codex'
    })
    vi.advanceTimersByTime(5_000)

    expect(await availabilityRows(runtime)).toEqual([])
    runtime.shutdownPaneAgentIdentityCensus(false)
  })

  it('does not classify live-agent prompt text as a typed launch', async () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    const binding = {
      tabId: '00000000-0000-4000-8000-000000000001',
      leafId: '00000000-0000-4000-8000-000000000002',
      incarnationId: 'incarnation-1',
      agentLaunchAuthority: {
        launchToken: 'launch-token',
        launchAgent: 'codex' as const,
        launchMode: 'orca-launch' as const
      }
    }
    runtime.registerPty('pty-native', 'folder:/tmp', null, binding)
    runtime.observeAcceptedPtyWrite('pty-native', 'claude\r')
    vi.advanceTimersByTime(5_000)

    expect(await availabilityRows(runtime)).toEqual([
      expect.objectContaining({ hostKind: 'native', launchMode: 'orca-launch', attestedRuns: 1 })
    ])

    runtime.emitDaemonPtyTransientFact('pty-native', {
      kind: 'command-finished',
      exitCode: 0
    })
    runtime.observeAcceptedPtyWrite('pty-native', 'claude\r')
    vi.advanceTimersByTime(5_000)
    expect(await availabilityRows(runtime)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ launchMode: 'orca-launch', attestedRuns: 1 }),
        expect.objectContaining({ launchMode: 'typed', attestedRuns: 1 })
      ])
    )
    runtime.shutdownPaneAgentIdentityCensus(false)
  })

  it('does not classify prompt text while a fresh hook owns an otherwise unattributed pane', async () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    const tabId = '00000000-0000-4000-8000-000000000001'
    const leafId = '00000000-0000-4000-8000-000000000002'
    runtime.registerPty('pty-native', 'folder:/tmp', null, {
      tabId,
      leafId,
      incarnationId: 'incarnation-1'
    })

    runtime.observeAgentHookStatus({
      paneKey: `${tabId}:${leafId}`,
      payload: { state: 'working', agentType: 'codex' }
    })
    runtime.observeAcceptedPtyWrite('pty-native', 'claude\r')
    vi.advanceTimersByTime(5_000)

    expect(await availabilityRows(runtime)).toEqual([])
    runtime.shutdownPaneAgentIdentityCensus(false)
  })

  it('does not carry a partial typed command across a PTY incarnation rebind', async () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    const binding = {
      tabId: '00000000-0000-4000-8000-000000000001',
      leafId: '00000000-0000-4000-8000-000000000002'
    }
    runtime.registerPty('pty-native', 'folder:/tmp', null, {
      ...binding,
      incarnationId: 'incarnation-1'
    })
    runtime.observeAcceptedPtyWrite('pty-native', 'co')
    runtime.registerPty('pty-native', 'folder:/tmp', null, {
      ...binding,
      incarnationId: 'incarnation-2'
    })
    runtime.observeAcceptedPtyWrite('pty-native', 'dex\r')
    vi.advanceTimersByTime(5_000)
    expect(await availabilityRows(runtime)).toEqual([])

    runtime.observeAcceptedPtyWrite('pty-native', 'codex\r')
    vi.advanceTimersByTime(5_000)
    expect(await availabilityRows(runtime)).toEqual([
      expect.objectContaining({ hostKind: 'native', launchMode: 'typed', attestedRuns: 1 })
    ])
    runtime.shutdownPaneAgentIdentityCensus(false)
  })

  it('attests only the first agent command in one accepted multiline write', async () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    const tabId = '00000000-0000-4000-8000-000000000001'
    const leafId = '00000000-0000-4000-8000-000000000002'
    runtime.registerPty('pty-ssh', 'folder:/tmp', 'ssh-1', {
      tabId,
      leafId,
      incarnationId: 'incarnation-1'
    })

    runtime.observeAcceptedPtyWrite('pty-ssh', 'claude\rcodex\r')
    runtime.observeAgentHookStatus({
      paneKey: `${tabId}:${leafId}`,
      connectionId: 'ssh-1',
      payload: { state: 'working', agentType: 'claude' }
    })
    vi.advanceTimersByTime(5_000)

    expect(await availabilityRows(runtime)).toEqual([
      expect.objectContaining({ hostKind: 'ssh', launchMode: 'typed', attestedRuns: 1 })
    ])
    runtime.shutdownPaneAgentIdentityCensus(false)
  })

  it('collects primary hook-server evidence for the exact live pane', async () => {
    vi.useFakeTimers()
    const census = new PaneAgentIdentityCensus({ emit: null })
    const record = vi.spyOn(census, 'record')
    const runtime = new OrcaRuntimeService(undefined, undefined, {
      paneAgentIdentityCensus: census
    })
    const tabId = '00000000-0000-4000-8000-000000000001'
    const leafId = '00000000-0000-4000-8000-000000000002'
    runtime.registerPty('pty-native', 'folder:/tmp', null, {
      tabId,
      leafId,
      incarnationId: 'incarnation-1',
      agentLaunchAuthority: {
        launchToken: 'launch-token',
        launchAgent: 'codex',
        launchMode: 'orca-launch'
      }
    })

    expect(
      runtime.observeAgentHookStatus({
        paneKey: `${tabId}:${leafId}`,
        connectionId: 'wrong-host',
        payload: { state: 'working', agentType: 'codex' }
      })
    ).toBe(false)
    expect(
      runtime.observeAgentHookStatus({
        paneKey: `${tabId}:${leafId}`,
        payload: { state: 'working', agentType: 'codex' }
      })
    ).toBe(true)
    vi.advanceTimersByTime(5_000)

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ hostKind: 'native', sourceMask: 5 })
    )
    runtime.shutdownPaneAgentIdentityCensus(false)
  })

  it('normalizes headless authority observations to one relay row per run', async () => {
    vi.useFakeTimers()
    const census = new PaneAgentIdentityCensus({ emit: null, snapshotHostKind: 'relay' })
    const runtime = new OrcaRuntimeService(undefined, undefined, {
      paneAgentIdentityCensus: census
    })
    runtime.registerPty('pty-wsl', 'folder:/tmp', null, undefined, true)
    runtime.observeAcceptedPtyWrite('pty-wsl', 'codex\r')
    vi.advanceTimersByTime(5_000)

    expect(await availabilityRows(runtime)).toEqual([
      expect.objectContaining({ hostKind: 'relay', launchMode: 'typed', attestedRuns: 1 })
    ])
    runtime.shutdownPaneAgentIdentityCensus(false)
  })

  it('collects current process, hook, and title evidence through PTY production paths', async () => {
    vi.useFakeTimers()
    const census = new PaneAgentIdentityCensus({ emit: null })
    const record = vi.spyOn(census, 'record')
    const runtime = new OrcaRuntimeService(undefined, undefined, {
      paneAgentIdentityCensus: census
    })
    runtime.registerPty('pty-native', 'folder:/tmp', null, {
      tabId: '00000000-0000-4000-8000-000000000001',
      leafId: '00000000-0000-4000-8000-000000000002',
      incarnationId: 'incarnation-1'
    })
    runtime.setPtyController({ getForegroundProcess: async () => 'codex' } as never)
    runtime.observeAcceptedPtyWrite('pty-native', 'codex\r')
    await (
      runtime as unknown as {
        loadPtyForegroundAgentFromController: (ptyId: string) => Promise<boolean>
      }
    ).loadPtyForegroundAgentFromController('pty-native')
    runtime.onPtyData(
      'pty-native',
      '\x1b]9999;{"state":"working","agentType":"codex"}\x07' +
        '\x1b]9999;{"state":"done","agentType":"codex"}\x07' +
        '\x1b]0;Codex working\x07',
      Date.now()
    )
    vi.advanceTimersByTime(5_000)

    expect(record).toHaveBeenCalledWith({
      hostKind: 'native',
      launchMode: 'typed',
      sourceMask: 79,
      identityNull: false,
      ambiguousTopRank: false
    })
    runtime.shutdownPaneAgentIdentityCensus(false)
  })

  it('freezes an accepted run on a confirmed production exit', async () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    runtime.registerPty('pty-native', 'folder:/tmp', null, {
      tabId: '00000000-0000-4000-8000-000000000001',
      leafId: '00000000-0000-4000-8000-000000000002',
      incarnationId: 'incarnation-1'
    })
    runtime.observeAcceptedPtyWrite('pty-native', 'codex\r')
    runtime.onPtyExit('pty-native', 0, 'incarnation-1', { providerExitObserved: true })

    expect(await availabilityRows(runtime)).toEqual([
      expect.objectContaining({ hostKind: 'native', launchMode: 'typed', attestedRuns: 1 })
    ])
    vi.advanceTimersByTime(5_000)
    expect(await availabilityRows(runtime)).toHaveLength(1)
    runtime.shutdownPaneAgentIdentityCensus(false)
  })

  it('publishes title-candidate coverage and freezes a run on production rebind', async () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    const binding = {
      tabId: '00000000-0000-4000-8000-000000000001',
      leafId: '00000000-0000-4000-8000-000000000002',
      incarnationId: 'incarnation-1'
    }
    runtime.registerPty('pty-title', 'folder:/tmp', null, binding)
    runtime.onPtyData('pty-title', '\x1b]0;Codex working\x07', Date.now())
    vi.advanceTimersByTime(30_000)
    expect((await runtime.listTerminals()).agentIdentityAvailability?.candidateCoverage).toEqual([
      ['native', 1]
    ])

    runtime.registerPty('pty-rebind', 'folder:/tmp', null, binding)
    runtime.observeAcceptedPtyWrite('pty-rebind', 'codex\r')
    runtime.registerPty('pty-rebind', 'folder:/tmp', null, {
      ...binding,
      incarnationId: 'incarnation-2'
    })
    expect(await availabilityRows(runtime)).toEqual([
      expect.objectContaining({ hostKind: 'native', launchMode: 'typed', attestedRuns: 1 })
    ])
    runtime.shutdownPaneAgentIdentityCensus(false)
  })
})
