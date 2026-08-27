import { describe, expect, it } from 'vitest'
import { admitRendererAgentLaunchAuthority } from './launch-authority'

function admit(resumeProviderSession: unknown) {
  return admitRendererAgentLaunchAuthority({
    launchToken: 'token',
    spawnEnv: { ORCA_AGENT_LAUNCH_TOKEN: 'token' },
    launchAgent: 'codex',
    launchConfig: {} as never,
    resumeProviderSession,
    isReattach: false,
    hasStablePaneOwner: false,
    incarnationId: 'incarnation-1'
  })
}

describe('renderer agent launch authority', () => {
  it('classifies fresh launches and provider-session resumes distinctly', () => {
    expect(admit(undefined)).toMatchObject({ launchMode: 'orca-launch' })
    expect(admit('provider-session')).toMatchObject({ launchMode: 'resume' })
  })
})
