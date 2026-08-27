import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import {
  NO_GITHUB_AUTHORITY_POLICY,
  NO_GITHUB_AUTHORITY_POLICY_DIGEST,
  createWorkerAuthorityIsolationAttestation
} from '../../../shared/worker-authority-policy'
import { WORKER_AUTHORITY_IMAGE } from '../../providers/worker-authority-isolation'
import {
  admitWorkerContainerLifecycleReceipt,
  createWorkerContainerLifecycleBoundary,
  monitorWorkerContainerLifecycle,
  restoreWorkerContainerLifecycleMonitors
} from './worker-container-lifecycle'

describe('worker container lifecycle adapter', () => {
  let db: OrchestrationDb | undefined
  const roots: string[] = []

  afterEach(() => {
    db?.close()
    db = undefined
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function readyWorker(attested = false) {
    const root = mkdtempSync('/private/tmp/orca-container-lifecycle-test-')
    roots.push(root)
    db = new OrchestrationDb(join(root, 'orchestration.sqlite'))
    const task = db.createTask({ spec: 'container worker' })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    const capabilityRef = `sha256:${'1'.repeat(64)}` as const
    const lifecycle = createWorkerContainerLifecycleBoundary({
      dispatchId: started.dispatch.id,
      capabilityRef
    })
    roots.push(lifecycle.directory)
    if (attested) {
      db.recordWorkerAuthorityAttestation(
        started.dispatch.id,
        createWorkerAuthorityIsolationAttestation({
          request: {
            schemaVersion: 'worker_authority_launch/1',
            policy: NO_GITHUB_AUTHORITY_POLICY,
            policyDigest: NO_GITHUB_AUTHORITY_POLICY_DIGEST,
            capabilityRef,
            dispatchId: started.dispatch.id,
            worktreeId: 'repo::worktree',
            setupPolicy: 'skip',
            imageDigest: WORKER_AUTHORITY_IMAGE,
            lifecycleDirectory: lifecycle.directory,
            lifecycleBinding: lifecycle.binding
          },
          runtimeId: 'runtime',
          runId: task.run_id,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          agentId: 'codex',
          processIncarnation: 'runtime:pty:1'
        })
      )
    }
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'skipped',
      effects: []
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return { root, task, dispatchId: started.dispatch.id, lifecycle }
  }

  function writeReceipt(
    lifecycle: ReturnType<typeof createWorkerContainerLifecycleBoundary>,
    value: Record<string, unknown>
  ): void {
    writeFileSync(join(lifecycle.directory, 'result.json'), `${JSON.stringify(value)}\n`, {
      flag: 'wx',
      mode: 0o600
    })
  }

  it('admits one bound worker_done into existing settlement and is replay-idempotent', () => {
    const worker = readyWorker()
    const notify = vi.fn()
    const receipt = {
      schemaVersion: 'worker_lifecycle_receipt/1',
      dispatchId: worker.dispatchId,
      lifecycleBinding: worker.lifecycle.binding,
      type: 'worker_done',
      outcome: 'succeeded',
      subject: 'Implemented',
      body: 'Implemented the requested change. Focused tests pass. No work remains.'
    }
    writeReceipt(worker.lifecycle, receipt)

    expect(
      admitWorkerContainerLifecycleReceipt({
        db: db!,
        runId: worker.task.run_id,
        taskId: worker.task.id,
        dispatchId: worker.dispatchId,
        terminalHandle: 'term_worker',
        lifecycle: worker.lifecycle,
        notify
      })
    ).toBe(true)
    expect(db!.getTask(worker.task.id)?.status).toBe('completed')
    expect(notify).toHaveBeenCalledWith(`run:${worker.task.run_id}`, 'worker_done')
    expect(existsSync(join(worker.lifecycle.directory, 'result.json'))).toBe(false)
    expect(db!.getUnreadMessages(`run:${worker.task.run_id}`, ['worker_done'])).toHaveLength(1)

    writeReceipt(worker.lifecycle, receipt)
    expect(
      admitWorkerContainerLifecycleReceipt({
        db: db!,
        runId: worker.task.run_id,
        taskId: worker.task.id,
        dispatchId: worker.dispatchId,
        terminalHandle: 'term_worker',
        lifecycle: worker.lifecycle,
        notify
      })
    ).toBe(true)
    expect(db!.getUnreadMessages(`run:${worker.task.run_id}`, ['worker_done'])).toHaveLength(1)
  })

  it('rejects a mismatched binding without writing lifecycle state', () => {
    const worker = readyWorker()
    writeReceipt(worker.lifecycle, {
      schemaVersion: 'worker_lifecycle_receipt/1',
      dispatchId: worker.dispatchId,
      lifecycleBinding: `sha256:${'9'.repeat(64)}`,
      type: 'worker_done',
      outcome: 'succeeded',
      subject: 'Forged',
      body: 'Wrong lifecycle binding.'
    })

    expect(() =>
      admitWorkerContainerLifecycleReceipt({
        db: db!,
        runId: worker.task.run_id,
        taskId: worker.task.id,
        dispatchId: worker.dispatchId,
        terminalHandle: 'term_worker',
        lifecycle: worker.lifecycle,
        notify: vi.fn()
      })
    ).toThrow('worker_lifecycle_receipt_mismatch')
    expect(db!.getTask(worker.task.id)?.status).toBe('dispatched')
    expect(db!.getUnreadMessages(`run:${worker.task.run_id}`, ['worker_done'])).toHaveLength(0)
  })

  it('admits a bound escalation without settling the worker task', () => {
    const worker = readyWorker()
    const notify = vi.fn()
    writeReceipt(worker.lifecycle, {
      schemaVersion: 'worker_lifecycle_receipt/1',
      dispatchId: worker.dispatchId,
      lifecycleBinding: worker.lifecycle.binding,
      type: 'escalation',
      subject: 'Blocked: owner decision',
      body: 'The implementation requires a decision outside the worker boundary.'
    })

    expect(
      admitWorkerContainerLifecycleReceipt({
        db: db!,
        runId: worker.task.run_id,
        taskId: worker.task.id,
        dispatchId: worker.dispatchId,
        terminalHandle: 'term_worker',
        lifecycle: worker.lifecycle,
        notify
      })
    ).toBe(true)
    expect(db!.getTask(worker.task.id)?.status).toBe('dispatched')
    const messages = db!.getUnreadMessages(`run:${worker.task.run_id}`, ['escalation'])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ priority: 'high', subject: 'Blocked: owner decision' })
    expect(notify).toHaveBeenCalledWith(`run:${worker.task.run_id}`, 'escalation')
  })

  it('admits the reporter maximum body even when JSON escaping expands it', () => {
    const worker = readyWorker()
    writeReceipt(worker.lifecycle, {
      schemaVersion: 'worker_lifecycle_receipt/1',
      dispatchId: worker.dispatchId,
      lifecycleBinding: worker.lifecycle.binding,
      type: 'worker_done',
      outcome: 'succeeded',
      subject: 'Maximum escaped body',
      body: '\0'.repeat(64 * 1024)
    })

    expect(
      admitWorkerContainerLifecycleReceipt({
        db: db!,
        runId: worker.task.run_id,
        taskId: worker.task.id,
        dispatchId: worker.dispatchId,
        terminalHandle: 'term_worker',
        lifecycle: worker.lifecycle,
        notify: vi.fn()
      })
    ).toBe(true)
    expect(db!.getTask(worker.task.id)?.status).toBe('completed')
  })

  it('quarantines a malformed receipt, notifies the coordinator, and admits a correction', async () => {
    vi.useFakeTimers()
    try {
      const worker = readyWorker()
      const notify = vi.fn()
      writeFileSync(join(worker.lifecycle.directory, 'result.json'), '{malformed', {
        flag: 'wx',
        mode: 0o600
      })
      monitorWorkerContainerLifecycle({
        db: db!,
        runId: worker.task.run_id,
        taskId: worker.task.id,
        dispatchId: worker.dispatchId,
        terminalHandle: 'term_worker',
        lifecycle: worker.lifecycle,
        notify
      })

      expect(existsSync(join(worker.lifecycle.directory, 'result.json'))).toBe(false)
      expect(db!.getUnreadMessages(`run:${worker.task.run_id}`, ['escalation'])).toHaveLength(1)
      writeReceipt(worker.lifecycle, {
        schemaVersion: 'worker_lifecycle_receipt/1',
        dispatchId: worker.dispatchId,
        lifecycleBinding: worker.lifecycle.binding,
        type: 'worker_done',
        outcome: 'succeeded',
        subject: 'Corrected',
        body: 'The corrected lifecycle receipt is valid.'
      })

      await vi.advanceTimersByTimeAsync(250)

      expect(db!.getTask(worker.task.id)?.status).toBe('completed')
      expect(notify).toHaveBeenCalledWith(`run:${worker.task.run_id}`, 'escalation')
      expect(notify).toHaveBeenCalledWith(`run:${worker.task.run_id}`, 'worker_done')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconciles an existing deterministic message after an interrupted first admission', () => {
    const worker = readyWorker()
    const receipt = {
      schemaVersion: 'worker_lifecycle_receipt/1',
      dispatchId: worker.dispatchId,
      lifecycleBinding: worker.lifecycle.binding,
      type: 'worker_done',
      outcome: 'succeeded',
      subject: 'Recovered admission',
      body: 'The first settlement was interrupted. Replay reconciles it. No work remains.'
    }
    writeReceipt(worker.lifecycle, receipt)
    const settlement = vi.spyOn(db!, 'settleWorkerReport').mockImplementationOnce(() => {
      throw new Error('synthetic interruption')
    })
    const args = {
      db: db!,
      runId: worker.task.run_id,
      taskId: worker.task.id,
      dispatchId: worker.dispatchId,
      terminalHandle: 'term_worker',
      lifecycle: worker.lifecycle,
      notify: vi.fn()
    }

    expect(() => admitWorkerContainerLifecycleReceipt(args)).toThrow('synthetic interruption')
    expect(db!.getTask(worker.task.id)?.status).toBe('dispatched')
    expect(db!.getUnreadMessages(`run:${worker.task.run_id}`, ['worker_done'])).toHaveLength(1)
    settlement.mockRestore()

    expect(admitWorkerContainerLifecycleReceipt(args)).toBe(true)
    expect(db!.getTask(worker.task.id)?.status).toBe('completed')
    expect(db!.getUnreadMessages(`run:${worker.task.run_id}`, ['worker_done'])).toHaveLength(1)
  })

  it('re-admits a retained receipt after the orchestration database restarts', () => {
    const worker = readyWorker(true)
    writeReceipt(worker.lifecycle, {
      schemaVersion: 'worker_lifecycle_receipt/1',
      dispatchId: worker.dispatchId,
      lifecycleBinding: worker.lifecycle.binding,
      type: 'worker_done',
      outcome: 'succeeded',
      subject: 'Recovered',
      body: 'The worker completed before restart. The retained receipt is valid. Nothing remains.'
    })
    db!.close()
    db = new OrchestrationDb(join(worker.root, 'orchestration.sqlite'))
    const notify = vi.fn()

    restoreWorkerContainerLifecycleMonitors({ db, notify })

    expect(db.getTask(worker.task.id)?.status).toBe('completed')
    expect(notify).toHaveBeenCalledWith(`run:${worker.task.run_id}`, 'worker_done')
  })
})
