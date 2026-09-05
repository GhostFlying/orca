import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RelayDispatcher } from '../../wsl-guest/dispatcher'
import { registerWslHookFsHandlers } from '../../wsl-guest/wsl-hook-fs-bridge'
import { SshChannelMultiplexer, type MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'
import { createWslHookSftpAdapter, installWslGuestHooks } from './wsl-hook-fs-adapter'
import {
  installRemoteManagedAgentHooks,
  REMOTE_MANAGED_HOOK_INSTALLER_AGENTS
} from './remote-managed-hook-installers'

type GuestHarness = {
  transport: MultiplexerTransport
  guestDispatcher: RelayDispatcher
  mux: SshChannelMultiplexer
}

function createGuestHarness(): GuestHarness {
  let relayFeed: ((data: Buffer) => void) | undefined
  const clientDataCallbacks: ((data: Buffer) => void)[] = []
  const closeCallbacks: (() => void)[] = []
  const transport: MultiplexerTransport = {
    write: (data, onSettled) => {
      setImmediate(() => {
        relayFeed?.(data)
        onSettled?.({ ok: true })
      })
    },
    supportsWriteSettlement: true,
    onData: (cb) => {
      clientDataCallbacks.push(cb)
    },
    onClose: (cb) => {
      closeCallbacks.push(cb)
    }
  }
  const guestDispatcher = new RelayDispatcher(
    (data: Buffer, onSettled) => {
      setImmediate(() => {
        for (const cb of clientDataCallbacks) {
          cb(data)
        }
        onSettled({ ok: true })
      })
    },
    { supportsWriteCallback: true }
  )
  relayFeed = (data) => guestDispatcher.feed(data)
  const mux = new SshChannelMultiplexer(transport)
  return { transport, guestDispatcher, mux }
}

describe.skipIf(process.platform === 'win32')(
  'createWslHookSftpAdapter over the guest fs bridge',
  () => {
    let home: string
    let harness: GuestHarness

    beforeEach(() => {
      home = mkdtempSync(join('/tmp', 'wsl-guest-home-'))
      harness = createGuestHarness()
      registerWslHookFsHandlers(harness.guestDispatcher, home)
    })

    afterEach(() => {
      harness.mux.dispose()
      harness.guestDispatcher.dispose()
      rmSync(home, { recursive: true, force: true })
    })

    it('maps guest ENOENT onto ssh2 status code 2', async () => {
      const adapter = createWslHookSftpAdapter(harness.mux)
      const err = await new Promise<Error & { code?: number }>((resolve) => {
        adapter.readFile(`${home}/missing.json`, 'utf8', ((e: Error) => resolve(e)) as never)
      })
      expect(err).toBeInstanceOf(Error)
      expect(err.code).toBe(2)
    })

    it('round-trips write/read/rename and rejects paths outside home', async () => {
      const adapter = createWslHookSftpAdapter(harness.mux)
      await new Promise<void>((resolve, reject) => {
        adapter.writeFile(
          `${home}/a.txt`,
          'hello',
          { encoding: 'utf8', mode: 0o600 } as never,
          ((e: Error | null) => (e ? reject(e) : resolve())) as never
        )
      })
      const content = await new Promise<string>((resolve, reject) => {
        adapter.readFile(`${home}/a.txt`, 'utf8', ((e: Error | null, value: string) =>
          e ? reject(e) : resolve(value)) as never)
      })
      expect(content).toBe('hello')

      await new Promise<void>((resolve, reject) => {
        adapter.ext_openssh_rename(`${home}/a.txt`, `${home}/b.txt`, ((e: Error | null) =>
          e ? reject(e) : resolve()) as never)
      })
      expect(existsSync(`${home}/b.txt`)).toBe(true)

      const outside = await new Promise<Error & { code?: number }>((resolve) => {
        adapter.readFile('/etc/passwd', 'utf8', ((e: Error) => resolve(e)) as never)
      })
      expect(outside).toBeInstanceOf(Error)
    })

    it('runs the unchanged remote managed hook installers against a WSL guest home', async () => {
      const adapter = createWslHookSftpAdapter(harness.mux)
      const results = await installRemoteManagedAgentHooks(adapter, home, {
        agents: REMOTE_MANAGED_HOOK_INSTALLER_AGENTS,
        claudeVersion: '2.1.310'
      })

      expect(results.length).toBeGreaterThan(0)
      expect(results.every((r) => r.state !== 'error')).toBe(true)

      const claudeSettings = JSON.parse(
        readFileSync(join(home, '.claude', 'settings.json'), 'utf8')
      )
      expect(claudeSettings.hooks.StopFailure).toBeTruthy()
      let rawVersion = '11.17.0'
      harness.guestDispatcher.onRequest('preflight.detectAgents', async () => ({
        agents: ['claude'],
        versions: { claude: rawVersion }
      }))
      const reinstall = () =>
        installWslGuestHooks({
          mux: harness.mux,
          guestHome: home,
          codexHomePath: null,
          distro: 'Ubuntu',
          installHooks: installRemoteManagedAgentHooks,
          settings: null,
          warn: (message) => {
            throw new Error(message)
          },
          installCodex: async () => null
        })
      await reinstall()
      expect(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))).toEqual(
        claudeSettings
      )
      rawVersion = 'launcher 11.17.0\n1.0.64 (Claude Code)'
      await reinstall()
      const oldSettings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))
      expect(oldSettings.hooks.StopFailure).toBeUndefined()
      expect(oldSettings.hooks.PreToolUse).toBeTruthy()
      const script = readFileSync(join(home, '.orca', 'agent-hooks', 'claude-hook.sh'), 'utf8')
      expect(script).toContain('/hook/claude')
    }, 20_000)
  }
)
