# Fork release maintenance

## Agent entry point

This is the complete operational runbook for `GhostFlying/orca` fork
maintenance. It assumes no prior conversation or local context. Read this file
before diagnosing a sync failure, resolving a replay conflict, changing either
maintenance workflow, moving a maintenance ref, or modifying a fork Release.

The executable sources of truth are:

- `.github/workflows/sync-upstream-release.yml`: Release discovery, transaction
  capture, anchor creation, patch replay, and candidate publication.
- `.github/workflows/fork-release-build.yml`: candidate validation, tests, all
  platform builds, Release asset verification, atomic promotion, and publish.
- `.github/scripts/upstream-release.mjs`: eligible Release selection and Release
  commit validation.
- `.github/scripts/fork-maintenance-state.mjs`: anchor, transaction metadata,
  patch subjects, stable patch IDs, and maintenance snapshot validation.
- `.github/scripts/fork-release-assets.mjs`: required asset set, checksums,
  metadata, and Release tag derivation.

Run the maintenance tests before publishing a candidate:

```sh
pnpm exec vitest run --config .github/scripts/vitest.config.mjs
pnpm exec oxlint .github/scripts config/scripts/fork-electron-builder-config.cjs
git diff --check
```

## Invariants

The production fork is a linear patch stack over one published upstream desktop
release:

```text
upstream-release = generated safe anchor over upstream vX.Y.Z
fork             = upstream-release + fork-only patches + maintenance snapshot
sync/upstream-release = the current candidate, and equals fork after promotion
```

Only published stable desktop releases matching `vX.Y.Z` are eligible. Drafts,
prereleases, release candidates, and mobile-only releases are ignored. The
upstream tag is dereferenced to its release commit, whose subject must be
`release: vX.Y.Z` and whose `package.json` version must be `X.Y.Z`. Upstream
release commits are detached version bumps and are not required to form a
first-parent or fast-forward chain.

The fork-only stack contains these changes in order:

1. `fix(mobile): honor pinned workspace display preference`
2. `docs(mobile): document workspace settings loaders`
3. `fix(mobile): show SSH labels in Run on picker`

Generated maintenance snapshots are excluded from the business patch stack.
Merge commits are forbidden. Empty patches are skipped during replay.
Patch subjects and stable patch IDs are pinned so similarly named extra changes
cannot enter the production stack.

## Synchronization

`sync-upstream-release.yml` polls the upstream Releases API hourly and also
supports a manually requested published stable tag. A run is a no-op when the
highest eligible release is already anchored. Otherwise it:

1. Pins the source `fork`, `upstream-release`, preview, upstream tag, and release
   commit SHAs.
2. Creates a safe anchor over the release commit while restoring this trusted
   maintenance snapshot.
3. Replays the fork-only stack and publishes `sync/upstream-release` with an
   exact force-with-lease.
4. The candidate push starts `fork-release-build.yml`, which runs validation
   and every unsigned Desktop/Mobile build against that exact SHA.
5. The candidate workflow creates or refreshes a draft GitHub prerelease and
   verifies every required artifact plus checksums and build metadata.
6. Its finalizer revalidates all pinned refs, atomically promotes `fork`,
   `upstream-release`, and `sync/upstream-release`, then publishes the draft.

The workflow uses the release tag commit after upstream has updated
`package.json`; it never follows the tip of upstream `main`. If polling skips
multiple releases, only the highest eligible release is built.

## Release artifacts

One fork prerelease contains all clients for the adopted upstream desktop
version:

- Windows x64: unsigned NSIS installer, blockmap, and fork update manifest.
- Linux x64 and arm64: AppImage, deb, and rpm packages.
- macOS x64 and arm64: DMG and ZIP with ad-hoc signing only; no Developer ID
  signing or notarization.
- Android: release APK, with no Play Store upload.
- iOS: unsigned IPA assembled from an unsigned Release `.app`; no Apple
  account, certificate, provisioning profile, TestFlight, or App Store upload.
- `checksums.txt` and `build-metadata.json` bind every asset to the candidate,
  upstream tag/commit, and checked-in desktop/mobile versions.

The tag is `vX.Y.Z-fork.<candidate-sha12>`. The Release is a prerelease and is
never GitHub's latest release. The release notes state that macOS may require
Gatekeeper override and iOS must be re-signed before sideloading.

## Failure and trust boundaries

A replay conflict, validation failure, missing artifact, build failure, or stale
lease leaves `fork` and `upstream-release` unchanged and never publishes a
partial Release. The candidate branch and draft may remain for diagnosis. A
retry for the same candidate replaces draft assets and completes promotion
idempotently.

Candidate code runs only in jobs with read-only repository permissions and no
write credentials. The repository-scoped deploy key is exposed only to the
final ref-push step. Release writes run in a finalizer that does not execute
candidate code. Every moving ref uses an exact lease and promotion is atomic.

Only these workflows are enabled in the fork:

- `sync-upstream-release.yml`
- `fork-release-build.yml`
- `pr.yml`
- `mobile.yml`
- `e2e.yml`

Other upstream workflows remain absent from maintenance refs and disabled at
the repository level. The safe anchor takes the standard PR, Mobile Checks, and
E2E workflow definitions from the selected upstream Release and the two
maintenance workflows from the current production fork.

## Protected refs and bootstrap

Bootstrap may rebuild only `fork`, `upstream-release`, and
`sync/upstream-release`. It removes the superseded `upstream-main` and
`sync/upstream-main` refs after the new flow succeeds. `main`, all PR/fix
branches, `GhostFlying/large_worktree`, and
`fix/workspace-changed-oversize-resync` must retain their original SHAs. The two
source branches for the selected fork patches are read-only inputs and are not
rewritten.

## Replay conflict recovery

The normal workflow stops before candidate publication when a cherry-pick
conflicts. `fork`, `upstream-release`, and any published Release must remain
unchanged. Resolve the conflict as a new candidate transaction; do not repair
the production branch in place.

### 1. Capture immutable inputs

Record the failing Actions run and inspect its `prepare`/replay output. Fetch,
without rewriting, the current remote values of:

- `fork`, `upstream-release`, and `sync/upstream-release`;
- the selected upstream `vX.Y.Z` tag and its dereferenced commit;
- the protected PR/fix branches listed above.

Confirm through the GitHub Releases API that the selected upstream Release is
published, not draft or prerelease, and matches `vX.Y.Z`. Confirm the release
commit subject is `release: vX.Y.Z` and `package.json` contains `X.Y.Z`. Do not
infer eligibility from a tag alone and do not use upstream `main`.

Use the real GitHub CLI and verify it with `gh --version` and `gh auth status`.
On the maintainer's current Linux machine the CLI is `/usr/bin/gh`;
`/usr/local/bin/gh` may be an unrelated executable.

Save every fetched SHA before changing the working branch. Those values are
the exact leases and the transaction trailers, not advisory observations.

### 2. Reproduce the transaction locally

Work in the repository's current primary working directory. Do not create a
new worktree unless the user requests one. From the selected upstream Release
commit, reproduce `Create safe release anchor` from
`sync-upstream-release.yml`:

1. Remove upstream workflows except `pr.yml`, `mobile.yml`, and `e2e.yml`.
2. Restore every maintenance path from the current production `fork`. This
   includes this runbook, maintenance scripts/workflows, the fork Electron
   builder config, and the unsigned iOS script. Preserve only the marked Fork
   Release Maintenance block from the production `AGENTS.md`; retain all other
   `AGENTS.md` content from the selected upstream Release.
3. Create one anchor commit with all required trailers:
   `Upstream-Release`, `Upstream-Commit`, `Fork-Maintenance-Source-Fork`,
   `Fork-Maintenance-Source-Anchor`, `Fork-Maintenance-Source-Preview`, and
   `Fork-Maintenance-Generated: upstream-anchor-v1`.
4. Use the Release commit date and the repository's configured Git identity.
   Do not add a bot/agent identity or co-author.

Obtain the ordered business patch list from the current production refs rather
than guessing from branch names:

```sh
node .github/scripts/fork-maintenance-state.mjs inspect \
  --anchor=<fetched-upstream-release-ref> \
  --fork=<fetched-fork-ref> \
  --target=<release-commit> \
  --enforce-patch-contract=true
```

Replay the returned `patchCommits` in order. Skip a patch only when Git proves
it is empty because upstream absorbed it. For a real conflict:

1. Read both the old patch intent and the new upstream implementation.
2. Resolve at the semantic/API level and preserve new upstream behavior.
3. Stage only the intended resolution and continue the cherry-pick so its
   original subject and author remain intact.
4. Run focused tests for the conflicted area before continuing.

The candidate must remain linear, merge-free, and limited to the ordered
approved patch subset. Never import the old worktree-timeout stack or another
PR branch. Never use a blanket `ours`/`theirs` resolution.

### 3. Update the patch contract when resolution changes a patch

If semantic conflict resolution changes a patch's stable patch ID, update the
corresponding ordered value in `EXPECTED_FORK_PATCH_IDS` in
`.github/scripts/fork-maintenance-state.mjs`. Put that update, and no business
code, in one final generated maintenance snapshot commit with trailer:

```text
Fork-Maintenance-Generated: maintenance-snapshot-v1
```

The snapshot may change only paths recognized by `MAINTENANCE_PATHS`, must be
the final candidate commit, and is excluded from the business patch stack. Do
not weaken or remove subject, patch-ID, linear-history, or path validation to
make a candidate pass.

### 4. Validate and publish only the candidate

Run the maintenance tests from the Agent entry point, focused conflict tests,
and `node .github/scripts/fork-maintenance-state.mjs inspect-candidate
--candidate=HEAD`. Then re-read all remote leases. If any source ref changed,
discard the transaction and regenerate its anchor metadata from the new state.

Push only the candidate to `sync/upstream-release`, using
`--force-with-lease=refs/heads/sync/upstream-release:<captured-preview-sha>`.
For a previously absent preview, use an empty expected value. Do not push
`fork`, `upstream-release`, tags, or PR/fix refs manually.

The candidate push must start `fork-release-build.yml`. If the workflow is
disabled, inspect repository workflow state, disable the superseded
`fork-sync.yml`, enable both new maintenance workflows, and dispatch the build
at the exact candidate ref. Do not re-enable unrelated upstream workflows.

### 5. Diagnose retries without bypassing the gate

- A transient job failure may be rerun for the exact same candidate.
- If candidate content must change, create a fresh transaction using the still
  current production refs and the latest preview SHA; do not amend a candidate
  while retaining stale source trailers.
- A draft Release may remain after failure. A same-candidate retry replaces its
  assets. Never publish it manually before finalization succeeds.
- Candidate and build jobs are read-only. Only the final ref-push step may use
  `FORK_MAINTENANCE_SSH_KEY`, and only the finalizer may write the Release.

### 6. Completion checklist

Do not report success until all of the following are true:

1. The complete Actions run, including every test shard, Desktop matrix entry,
   Android, unsigned iOS, release bundle, and finalizer, succeeded.
2. The GitHub Release is a published prerelease, targets the candidate SHA, and
   contains exactly the asset set described in `build-metadata.json` plus
   `checksums.txt`; downloaded hashes verify.
3. `fork` and `sync/upstream-release` equal the candidate SHA, and
   `upstream-release` equals its generated anchor SHA.
4. The fork tag resolves to the candidate SHA.
5. Every protected PR/fix branch SHA equals the value captured before recovery.
6. No unrelated workflow was enabled and the working tree is clean.
