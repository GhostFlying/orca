# Runtime agent provider session reference

Expose the existing optional hook-reported `providerSession` metadata in runtime
worktree agent rows, so consumers can locate the actual provider session and its
reported transcript without guessing paths. Reuse `AgentProviderSessionMetadata`.

Carry the field through PTY source collection, the source type, and row assembly.
Do not change source admission, freshness, provider-only or unconfirmed filtering,
and do not infer metadata when a hook or older host omits it. This additive optional
field applies equally to local/remote and repository/folder workspaces.

Verify source-to-row projection for an admitted terminal, absence for legacy
metadata, and rejection of disconnected, provider-only and unconfirmed sources.
Run focused runtime tests, Node typecheck and lint. This change prepares a reviewed
product hotfix; release publication must use the fork hotfix candidate workflow.
