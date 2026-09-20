# v1.4.197 fork maintenance implementation

1. Build a safe v1.4.197 anchor from the captured production refs.
2. Make `upstream-release..fork` the only business-patch source and remove persistent commit pins and patch-content allowlists.
3. Rebuild the still-needed fork behavior against v1.4.197, dropping or shrinking patches already covered by upstream abstractions.
4. Validate the candidate locally, publish only `sync/upstream-release` with its captured lease, and let the build finalizer promote production refs.

## v1.4.197 patch audit

- Keep pinned-workspace behavior; fold its loader documentation into the same commit.
- Keep only the mobile Run-on host-label consumer because upstream now owns shared host-label state.
- Keep last-successful worktree metadata for scan timeouts; upstream only covers failed scans.
- Keep Trae hook/status integration; upstream does not provide the complete status path.
- Keep TraeX support, split into observed identity, trusted transcript access, and mobile consumption.

## Storage model decision

Continue using real commits in `upstream-release..fork`. A separate patch repository would decouple patch artifacts from replayed SHAs, but it would introduce cross-repository transaction/version management and patches that cannot be built or tested until applied. The current range model preserves native review, tests, and bisectability while removing the mistaken assumption that replayed commit SHAs remain stable.
