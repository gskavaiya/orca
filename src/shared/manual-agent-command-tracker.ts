import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'
import type { TuiAgent } from './tui-agent'

export const MANUAL_AGENT_COMMAND_MAX_CHARS = 4_096

/** Bounded shell-line shadow used by both UI ownership inference and execution authorities. */
export class ManualAgentCommandTracker {
  private line = ''
  private cursor = 0
  private suspended = false
  private acceptedCount = 0

  ingest(data: string): TuiAgent[] {
    const accepted: TuiAgent[] = []
    if (this.suspended) {
      if (data.includes('\x03') || data.includes('\x15')) {
        this.reset()
      } else if (data.includes('\r') || data.includes('\n')) {
        this.suspended = false
      }
      return accepted
    }
    if (data.length > MANUAL_AGENT_COMMAND_MAX_CHARS) {
      this.reset()
      this.suspended = !data.includes('\r') && !data.includes('\n')
      return accepted
    }
    for (let index = 0; index < data.length; index += 1) {
      const char = data[index]!
      if (char === '\r' || char === '\n') {
        if (!this.suspended) {
          const recognized = recognizeAgentProcessFromCommandLine(this.line.trim())
          if (recognized) {
            accepted.push(recognized.agent)
            this.acceptedCount += 1
          }
        }
        this.reset()
        continue
      }
      if (char === '\x7f' || char === '\b') {
        this.backspace()
        continue
      }
      if (char === '\x03' || char === '\x15') {
        this.reset()
        continue
      }
      if (char === '\x17') {
        this.deleteWord()
        continue
      }
      if (char === '\x1b' && data[index + 1] === '[') {
        const nextIndex = this.consumeCsi(data, index)
        if (nextIndex === null) {
          this.reset()
        } else {
          index = nextIndex - 1
        }
        continue
      }
      if (char < ' ') {
        this.reset()
        continue
      }
      if (this.line.length >= MANUAL_AGENT_COMMAND_MAX_CHARS) {
        this.suspended = true
        return accepted
      }
      this.line = this.line.slice(0, this.cursor) + char + this.line.slice(this.cursor)
      this.cursor += 1
    }
    return accepted
  }

  reset(): void {
    this.line = ''
    this.cursor = 0
    this.suspended = false
  }
  cancelSuspendedInference(): void {
    if (this.suspended) {
      this.reset()
    }
  }
  get acceptedCommandCount(): number {
    return this.acceptedCount
  }
  private backspace(): void {
    if (this.cursor > 0) {
      this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor)
      this.cursor -= 1
    }
  }
  private deleteWord(): void {
    const before = this.line.slice(0, this.cursor).replace(/[^\S\r\n]*\S+[^\S\r\n]*$/, '')
    this.line = before + this.line.slice(this.cursor)
    this.cursor = before.length
  }
  private consumeCsi(data: string, index: number): number | null {
    let cursor = index + 2
    while (cursor < data.length && /[0-9;?]/.test(data[cursor]!)) {
      cursor += 1
    }
    const final = data[cursor]
    if (!final || !/[~A-Za-z]/.test(final)) {
      return null
    }
    const params = data.slice(index + 2, cursor)
    if (final === 'D' && params === '') {
      this.cursor = Math.max(0, this.cursor - 1)
    } else if (final === 'C' && params === '') {
      this.cursor = Math.min(this.line.length, this.cursor + 1)
    } else if (final === 'H' || (final === '~' && params === '1')) {
      this.cursor = 0
    } else if (final === 'F' || (final === '~' && params === '4')) {
      this.cursor = this.line.length
    } else if (final === '~' && params === '3' && this.cursor < this.line.length) {
      this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1)
    } else if (final !== '~' || (params !== '200' && params !== '201')) {
      this.reset()
    }
    return cursor + 1
  }
}
