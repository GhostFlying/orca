import type { RpcClient } from '../transport/rpc-client'
import { optionalSettingsRead } from '../transport/settings-read-operations'
import type { RpcResponse } from '../transport/types'
import { getShowPinnedWorktreesInGroups } from '../worktree/workspace-view-settings'
import type { WorkspaceViewSettings } from '../worktree/workspace-view-settings'
import { hostViewSettingsRead, hostViewSettingsWrite } from './host-screen-operations'

function readViewSettings(reply: RpcResponse | null): WorkspaceViewSettings | undefined {
  if (!reply) {
    return undefined
  }
  try {
    const result = hostViewSettingsRead.interpret(reply)
    return result.accepted ? result.value : undefined
  } catch {
    return undefined
  }
}

function readPinnedPreference(reply: RpcResponse | null): boolean | undefined {
  if (!reply) {
    return undefined
  }
  try {
    const result = optionalSettingsRead.interpret(reply)
    return result.accepted ? getShowPinnedWorktreesInGroups(result.value) : undefined
  } catch {
    return undefined
  }
}

export async function loadHostViewSettings(client: RpcClient): Promise<{
  ui?: WorkspaceViewSettings
  showPinnedWorktreesInGroups?: boolean
}> {
  const [uiReply, settingsReply] = await Promise.all([
    hostViewSettingsRead.request(client).catch(() => null),
    optionalSettingsRead.request(client).catch(() => null)
  ])
  return {
    ui: readViewSettings(uiReply),
    showPinnedWorktreesInGroups: readPinnedPreference(settingsReply)
  }
}

export async function saveHostViewSettings(
  client: RpcClient,
  settings: WorkspaceViewSettings
): Promise<void> {
  await hostViewSettingsWrite.request(client, settings)
}
