import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'

export function readBoundedWorkerLifecycleReceipt(path: string, maxBytes: number): string {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(descriptor)
    const pathStat = lstatSync(path)
    if (
      !stat.isFile() ||
      pathStat.isSymbolicLink() ||
      pathStat.dev !== stat.dev ||
      pathStat.ino !== stat.ino ||
      stat.size > maxBytes
    ) {
      throw new Error('worker_lifecycle_receipt_invalid')
    }
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null)
      if (count === 0) {
        break
      }
      offset += count
    }
    if (offset !== bytes.length) {
      throw new Error('worker_lifecycle_receipt_invalid')
    }
    return bytes.toString('utf8')
  } catch (error) {
    if (error instanceof Error && error.message === 'worker_lifecycle_receipt_invalid') {
      throw error
    }
    throw new Error('worker_lifecycle_receipt_invalid')
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor)
    }
  }
}
