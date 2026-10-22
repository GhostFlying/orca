# Folder workspace CLI

Expose existing folderWorkspace and projectGroup RPC methods through explicit CLI
commands. Creation requires a group and an explicit folder path; deletion removes
the Orca registration, never the directory. IDs remain stable when names change.
Support local and paired remote runtimes without introducing wire changes.

Add command specs and lazy handler routing, validate required flags, and cover
RPC arguments, missing IDs and paths, rename behavior and registry parity in tests.

Validation includes the CLI-native typecheck, handler/manifest tests and changed-file static checks. Produce a versioned standalone CLI artifact without installing or replacing the global CLI or runtime. Run a real CLI-only smoke against the existing runtime using one uniquely named temporary group, folder registration and directory. Record created IDs immediately, verify stable ID/path after renaming, check terminals without launching one, then remove only the owned registration and empty group in finally cleanup and verify their absence. No Electron renderer or agent/model execution is part of this CLI smoke.

Mixed-version smoke confirmed that native folder identity must be passed to terminal queries with the explicit `id:folder:<workspace-id>` selector. The existing runtime does not enumerate these folders in its Git worktree catalog, so raw folder keys, display names and paths are not safe fallback selectors. Folder registration CRUD and metadata updates use the existing native RPC methods without upgrading the runtime.

Independent review identified two boundary fixes: an explicit SSH connection selects a remote filesystem even when the runtime itself is local, so both create commands must preserve remote absolute paths and reject relative paths. Folder updates that return a null resource must fail with not_found rather than report success. Add fixtures for SSH Windows/POSIX paths and missing update targets, then repeat the focused gates and smoke before committing.

Filesystem selection also inherits connectionId from the selected project group when no explicit connection is supplied. Read that group before resolving a local caller's creation path; a missing group is not a local-filesystem fallback. Metadata-only updates do not resolve or alter paths.

Both removal specs participate in the existing destructive-command intent filter: benign listing/move typos must not recommend deletion, while explicit removal typos remain recoverable. Cover the actual command registry rather than mirroring a flag in a unit assertion.
