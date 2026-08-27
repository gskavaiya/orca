import { PaneAgentIdentityCensus } from './pane-agent-identity-census'

export function createDesktopPaneAgentIdentityCensus(): PaneAgentIdentityCensus {
  return new PaneAgentIdentityCensus()
}

export function createHeadlessPaneAgentIdentityCensus(): PaneAgentIdentityCensus {
  return new PaneAgentIdentityCensus({ emit: null, snapshotHostKind: 'relay' })
}
