import type { HandlerGroup } from './handler-group-manifest'

export const FOLDER_WORKSPACE_HANDLER_GROUP: HandlerGroup = {
  name: 'folder-workspace',
  keys: [
    'folder-workspace list',
    'folder-workspace create',
    'folder-workspace show',
    'folder-workspace update',
    'folder-workspace rm',
    'project-group list',
    'project-group create',
    'project-group rm'
  ],
  load: async () => (await import('./handlers/folder-workspace.js')).FOLDER_WORKSPACE_HANDLERS
}
