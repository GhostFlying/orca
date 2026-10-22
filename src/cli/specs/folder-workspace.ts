import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const FOLDER_WORKSPACE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['folder-workspace', 'list'],
    summary: 'List native folder workspaces',
    usage: 'orca folder-workspace list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['folder-workspace', 'create'],
    summary: 'Register a folder workspace at an explicit directory',
    usage:
      'orca folder-workspace create --group <id> --path <path> --name <name> [--connection <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'group', 'path', 'name', 'connection']
  },
  {
    path: ['folder-workspace', 'show'],
    summary: 'Show a folder workspace by its stable ID',
    usage: 'orca folder-workspace show --workspace <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'workspace']
  },
  {
    path: ['folder-workspace', 'update'],
    summary: 'Update folder workspace display metadata',
    usage:
      'orca folder-workspace update --workspace <id> [--name <name>] [--comment <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'workspace', 'name', 'comment']
  },
  {
    path: ['folder-workspace', 'rm'],
    destructive: true,
    summary: 'Remove a folder workspace registration without deleting its directory',
    usage: 'orca folder-workspace rm --workspace <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'workspace']
  },
  {
    path: ['project-group', 'rm'],
    destructive: true,
    summary: 'Remove a project group registration',
    usage: 'orca project-group rm --group <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'group']
  },
  {
    path: ['project-group', 'list'],
    summary: 'List project groups',
    usage: 'orca project-group list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['project-group', 'create'],
    summary: 'Create a project group',
    usage: 'orca project-group create --name <name> [--path <path>] [--connection <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name', 'path', 'connection']
  }
]
