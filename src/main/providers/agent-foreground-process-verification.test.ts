import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, getAllProcessesMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  getAllProcessesMock: vi.fn()
}))

vi.mock('child_process', () => ({ execFile: execFileMock }))

import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot'
import { __setWindowsProcessTreeLoaderForTests } from '../windows/windows-process-table'
import {
  resolveAgentForegroundProcess,
  resolveAgentForegroundProcessWithAvailability
} from './agent-foreground-process'

type NativeProcessRow = {
  pid: number
  ppid: number
  name: string
  commandLine?: string
}

const SHELL_ROW = {
  pid: 100,
  ppid: 99,
  name: 'powershell.exe',
  commandLine: 'powershell.exe'
}

function mockPs(stdout: string): void {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
    const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
    callback(null, { stdout, stderr: '' })
  })
}

function mockWindowsRows(rows: NativeProcessRow[]): void {
  getAllProcessesMock.mockImplementation((callback: (snapshot: NativeProcessRow[]) => void) => {
    callback([{ pid: process.pid, ppid: 0, name: 'vitest.exe', commandLine: 'vitest' }, ...rows])
  })
}

describe('TraeX foreground process evidence', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    getAllProcessesMock.mockReset()
    resetProcessTableSnapshotForTests()
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
      getAllProcesses: getAllProcessesMock
    }))
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  })

  afterEach(() => {
    __setWindowsProcessTreeLoaderForTests()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('requires command-line evidence on POSIX', async () => {
    mockPs('101 100 S+   traex -p ultra')
    await expect(resolveAgentForegroundProcess(100, 'traex')).resolves.toBe('traex')

    resetProcessTableSnapshotForTests()
    mockPs('101 100 S+   traex app-server')
    await expect(resolveAgentForegroundProcess(100, 'traex')).resolves.toBeNull()
  })

  it('does not restore a recognized fallback missing from a fresh scan', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([SHELL_ROW])

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'droid', {
        fresh: true,
        forceProcessScan: true
      })
    ).resolves.toEqual({ available: true, processName: null })
  })

  it('recognizes an interactive command on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      SHELL_ROW,
      { pid: 101, ppid: 100, name: 'traex.exe', commandLine: 'traex -p ultra' }
    ])

    await expect(resolveAgentForegroundProcess(100, 'traex.exe')).resolves.toBe('traex')
  })

  it('rejects a background command on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      SHELL_ROW,
      { pid: 101, ppid: 100, name: 'traex.exe', commandLine: 'traex app-server' }
    ])

    await expect(resolveAgentForegroundProcessWithAvailability(100, 'traex.exe')).resolves.toEqual({
      available: true,
      processName: null
    })
  })

  it('rejects an unreadable Windows command line', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([SHELL_ROW, { pid: 101, ppid: 100, name: 'traex.exe' }])

    await expect(resolveAgentForegroundProcessWithAvailability(100, 'traex.exe')).resolves.toEqual({
      available: true,
      processName: null
    })
  })
})
