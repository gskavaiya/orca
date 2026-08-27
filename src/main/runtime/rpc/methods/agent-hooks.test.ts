import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { isStreamingMethod, type RpcContext } from '../core'

const { installForRuntimeHomeMock } = vi.hoisted(() => ({
  installForRuntimeHomeMock: vi.fn()
}))

vi.mock('../../../codex/hook-service', () => ({
  codexHookService: { installForRuntimeHome: installForRuntimeHomeMock }
}))

import { AGENT_HOOK_METHODS } from './agent-hooks'

function prepareMethod() {
  const method = AGENT_HOOK_METHODS.find(
    (candidate) => candidate.name === 'agentHooks.prepareCodexForWslPane'
  )
  if (!method || isStreamingMethod(method)) {
    throw new Error('Missing agentHooks.prepareCodexForWslPane request method')
  }
  return method
}

function runtimeWithSettings(enabled = true, disabledTuiAgents: string[] = []): OrcaRuntimeService {
  return {
    getClientSettings: vi.fn(() => ({
      agentStatusHooksEnabled: enabled,
      disabledTuiAgents
    }))
  } as unknown as OrcaRuntimeService
}

describe('agent hook RPC methods', () => {
  beforeEach(() => {
    installForRuntimeHomeMock.mockReset()
  })

  it('installs the pane-selected WSL home once and returns its status', async () => {
    const status = { agent: 'codex', state: 'installed' }
    installForRuntimeHomeMock.mockResolvedValue(status)
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      orcaCodexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      wslDistro: 'Ubuntu-24.04'
    })

    await expect(method.handler(params, { runtime: runtimeWithSettings() })).resolves.toBe(status)
    expect(installForRuntimeHomeMock).toHaveBeenCalledExactlyOnceWith(
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\.local\\share\\orca\\codex-runtime-home\\home',
      { runtime: 'wsl', wslDistro: 'Ubuntu-24.04' }
    )
  })

  it.each([
    [false, []],
    [true, ['codex']]
  ])('does not install when hooks are disabled (%s, %j)', async (enabled, disabledTuiAgents) => {
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      orcaCodexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      wslDistro: 'Ubuntu'
    })

    await expect(
      method.handler(params, { runtime: runtimeWithSettings(enabled, disabledTuiAgents) })
    ).resolves.toBeNull()
    expect(installForRuntimeHomeMock).not.toHaveBeenCalled()
  })

  it('rejects non-local callers', async () => {
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      orcaCodexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      wslDistro: 'Ubuntu'
    })

    await expect(
      method.handler(params, {
        runtime: runtimeWithSettings(),
        clientKind: 'runtime'
      } as RpcContext)
    ).rejects.toThrow(/only available to the local Orca CLI/)
    expect(installForRuntimeHomeMock).not.toHaveBeenCalled()
  })

  it('propagates an attempted installer failure', async () => {
    installForRuntimeHomeMock.mockRejectedValue(new Error('install failed'))
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      orcaCodexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      wslDistro: 'Ubuntu'
    })

    await expect(method.handler(params, { runtime: runtimeWithSettings() })).rejects.toThrow(
      'install failed'
    )
    expect(installForRuntimeHomeMock).toHaveBeenCalledOnce()
  })

  it('rejects malformed distro names at the RPC schema', () => {
    const method = prepareMethod()

    expect(() =>
      method.params!.parse({
        codexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
        orcaCodexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
        wslDistro: 'Ubuntu\\..\\host'
      })
    ).toThrow()
  })
})
