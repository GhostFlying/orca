export const TEND_WORKSPACE_GROUP_KEY = 'tend:workspaces'
export const TEND_DIRECTORY_GROUP_KEY = 'tend:directories'

export function isTendWorkspaceComment(comment: string): boolean {
  return (
    /^tend workspace [A-Za-z0-9_-]+(?:\r?\n|$)/.test(comment) ||
    /^tend task [A-Za-z0-9_-]+\r?\nworkspace [A-Za-z0-9_-]+\r?\nkind [A-Za-z0-9_-]*\r?\nrole (?:implement|accept)(?:\r?\n|$)/.test(
      comment
    )
  )
}

export function isTendWorkspaceGroupKey(key: string): boolean {
  return (
    key === TEND_WORKSPACE_GROUP_KEY ||
    key.startsWith(`${TEND_WORKSPACE_GROUP_KEY}:`) ||
    key === TEND_DIRECTORY_GROUP_KEY
  )
}
