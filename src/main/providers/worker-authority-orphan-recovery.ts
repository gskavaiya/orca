import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '../../shared/child-process/run-process'
import { NO_GITHUB_AUTHORITY_POLICY_DIGEST } from '../../shared/worker-authority-policy'
import {
  WORKER_AUTHORITY_CID_FILE,
  WORKER_AUTHORITY_DOCKER_PATH,
  WORKER_AUTHORITY_NONCE_LABEL,
  WORKER_AUTHORITY_OWNERSHIP_FILE,
  WORKER_AUTHORITY_POLICY_LABEL,
  WORKER_AUTHORITY_ROOT_LABEL,
  WORKER_AUTHORITY_ROOT_PREFIX
} from './worker-authority-container-contract'

export type WorkerAuthorityOrphanRecovery = {
  removedContainers: number
  removedRoots: number
  rejectedRoots: number
}

function readRegularBoundedFile(path: string, maxBytes: number): string | null {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
      return null
    }
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}

type OwnedContainerInspection = 'owned' | 'absent' | 'rejected' | 'unavailable'

function inspectOwnedContainer(cid: string, root: string, nonce: string): OwnedContainerInspection {
  const result = runProcessSync({
    program: WORKER_AUTHORITY_DOCKER_PATH,
    args: ['inspect', '--format', '{{json .Config.Labels}}', cid],
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024
  })
  if (result.code !== 0) {
    // `docker inspect` uses the same non-zero status for an absent container and an
    // unavailable daemon. Remove the private root only after a second successful Docker
    // read proves that this exact CID is absent; otherwise retain it for the next restart.
    const inventory = runProcessSync({
      program: WORKER_AUTHORITY_DOCKER_PATH,
      args: ['container', 'ls', '--all', '--no-trunc', '--quiet', '--filter', `id=${cid}`],
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024
    })
    if (inventory.code !== 0) {
      return 'unavailable'
    }
    const retainedIds = inventory.stdout.split(/\s+/).filter(Boolean)
    return retainedIds.includes(cid) ? 'rejected' : 'absent'
  }
  try {
    const labels = JSON.parse(result.stdout) as Record<string, unknown>
    return labels &&
      labels[WORKER_AUTHORITY_POLICY_LABEL] === NO_GITHUB_AUTHORITY_POLICY_DIGEST &&
      labels[WORKER_AUTHORITY_ROOT_LABEL] === root &&
      labels[WORKER_AUTHORITY_NONCE_LABEL] === nonce
      ? 'owned'
      : 'rejected'
  } catch {
    return 'rejected'
  }
}

function isOwnedRoot(root: string): boolean {
  try {
    const stat = lstatSync(root)
    const uid = process.getuid?.()
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      realpathSync(root) === root &&
      (uid === undefined || stat.uid === uid) &&
      (stat.mode & 0o077) === 0
    )
  } catch {
    return false
  }
}

export function recoverOrphanedWorkerAuthorityContainers(args?: {
  platform?: NodeJS.Platform
  tempRoot?: string
}): WorkerAuthorityOrphanRecovery {
  const outcome: WorkerAuthorityOrphanRecovery = {
    removedContainers: 0,
    removedRoots: 0,
    rejectedRoots: 0
  }
  if ((args?.platform ?? process.platform) !== 'darwin') {
    return outcome
  }
  const tempRoot = realpathSync(args?.tempRoot ?? tmpdir())
  let entries: string[]
  try {
    entries = readdirSync(tempRoot)
  } catch {
    return outcome
  }
  for (const name of entries) {
    if (!name.startsWith(WORKER_AUTHORITY_ROOT_PREFIX)) {
      continue
    }
    const root = join(tempRoot, name)
    const nonce = readRegularBoundedFile(join(root, WORKER_AUTHORITY_OWNERSHIP_FILE), 128)
    const cid = readRegularBoundedFile(join(root, WORKER_AUTHORITY_CID_FILE), 128)
    if (!isOwnedRoot(root) || !nonce || !/^[0-9a-f]{64}$/.test(nonce)) {
      outcome.rejectedRoots++
      continue
    }
    if (!cid || !/^[0-9a-f]{64}$/.test(cid)) {
      outcome.rejectedRoots++
      continue
    }
    try {
      const inspection = inspectOwnedContainer(cid, root, nonce)
      if (inspection === 'rejected' || inspection === 'unavailable') {
        outcome.rejectedRoots++
        continue
      }
      if (inspection === 'owned') {
        const removal = runProcessSync({
          program: WORKER_AUTHORITY_DOCKER_PATH,
          args: ['rm', '--force', cid],
          timeoutMs: 5_000,
          maxOutputBytes: 1024
        })
        if (removal.code !== 0) {
          outcome.rejectedRoots++
          continue
        }
        outcome.removedContainers++
      }
      rmSync(root, { recursive: true, force: true })
      outcome.removedRoots++
    } catch {
      outcome.rejectedRoots++
    }
  }
  return outcome
}
