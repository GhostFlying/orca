# Fork release maintenance

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
