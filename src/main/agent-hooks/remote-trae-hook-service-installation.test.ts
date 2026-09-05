import { describe, expect, it, vi } from 'vitest'
import { TraeHookService } from '../trae/hook-service'
import { createAgentHookMemorySftp } from './agent-hook-memory-sftp.test-fixture'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

describe('remote Trae hook service installation', () => {
  it('installs hooks into resolved homes and enables them', async () => {
    const { sftp, fs } = createAgentHookMemorySftp()
    const status = await new TraeHookService().installRemote(sftp, '/home/dev', {
      traeHomeDir: '/home/dev/.config/trae',
      traeCliHomeDir: '/home/dev/.cache/traecli'
    })

    expect(status).toMatchObject({
      agent: 'trae',
      state: 'installed',
      configPath: '/home/dev/.cache/traecli/hooks.json'
    })
    const hooks = JSON.parse(fs.files.get('/home/dev/.cache/traecli/hooks.json')!)
    expect(hooks.hooks.PermissionRequest[0].hooks[0].command).toContain('trae-hook.sh')
    expect(fs.files.get('/home/dev/.orca/agent-hooks/trae-hook.sh')).toContain('/hook/trae')
    expect(fs.files.get('/home/dev/.config/trae/traecli.toml')).toContain(
      '[features]\nhooks = true'
    )
  })
})
