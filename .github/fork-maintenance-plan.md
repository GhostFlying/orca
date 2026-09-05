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
  source-range extraction, and maintenance snapshot validation.
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
upstream tag is dereferenced to its release commit, whose `package.json`
version must be `X.Y.Z`. Commit subjects are not part of Release identity; for
example, `v1.4.197` intentionally carries a longer release subject. Upstream
release commits are detached version bumps and are not required to form a
first-parent or fast-forward chain.

For each transaction, the complete ordered business patch stack is exactly the
commit range captured from `upstream-release..fork`, excluding an optional final
generated maintenance snapshot. There is no persistent list of commit SHAs,
subjects, branch names, or stable patch IDs. Replayed commits naturally receive
new SHAs when their parent changes.

The stack audited while adopting `v1.4.197` contains these still-needed changes
in order:

1. `fix(mobile): honor pinned workspace display preference`
2. `fix(mobile): show host labels in Run on picker`
3. `fix(runtime): preserve worktree names across scan stalls`
4. `fix(agents): complete Trae status integration`
5. `feat(agent): recognize TraeX sessions`
6. `feat(native-chat): read TraeX transcripts`
7. `feat(mobile): support existing TraeX chats`

The former two-line workspace-loader documentation patch was folded into the
workspace behavior patch. The host-label patch now reuses upstream's shared
host-label state. The scan-stall patch keeps only last-successful metadata that
upstream's failure fallback does not cover. Trae status and TraeX chat remain
fork-only as of that Release. Repeat this semantic audit on every new upstream
Release; a clean cherry-pick alone is not evidence that a patch remains useful.

Generated maintenance snapshots are excluded from the business patch stack.
Merge commits are forbidden. Empty patches are skipped during replay. Business
patches may not change maintenance paths; maintenance changes belong in the
single optional final generated snapshot.

## Synchronization

`sync-upstream-release.yml` polls the upstream Releases API hourly and also
supports a manually requested published stable tag. A run is a no-op when the
highest eligible release is already anchored. Otherwise it:

1. Captures exact transaction leases for the source `fork`,
   `upstream-release`, preview, upstream tag, and release commit. These guard
   concurrent ref movement; they do not identify individual business patches.
2. Creates a safe anchor over the release commit while restoring this trusted
   maintenance snapshot.
3. Replays the fork-only stack and publishes `sync/upstream-release` with an
   exact force-with-lease.
4. The candidate push starts `fork-release-build.yml`, which runs validation
   and every Desktop/Mobile build against that exact SHA. Android is built
   unsigned, then signed in an isolated job with the fork release key.
5. The candidate workflow creates or refreshes a draft GitHub prerelease and
   verifies every required artifact plus checksums and build metadata.
6. Its finalizer revalidates all captured ref leases, atomically promotes `fork`,
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
- Android: release APK signed with the fork-only key stored in GitHub Actions
  secrets, with no Play Store upload. The signing job rejects the public Expo
  debug certificate, verifies the fork certificate identity, and records the
  actual certificate SHA-256 in `build-metadata.json`.
  APKs from earlier fork Releases used the public Expo debug key, so moving to
  this key requires one uninstall/reinstall; later fork APKs can update in place.
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
write credentials. The Android signing key is exposed only to an isolated job
that downloads the unsigned APK and does not check out or execute candidate
code. The repository-scoped deploy key is exposed only to the final ref-push
step. Release writes run in a finalizer that does not execute candidate code.
Every moving ref uses an exact lease and promotion is atomic.

Only these workflows are enabled in the fork:

- `sync-upstream-release.yml`
- `fork-release-build.yml`
- `pr.yml`
- `mobile.yml`

The upstream `e2e.yml` definition remains in maintenance refs for source
parity, but is disabled at the repository level along with all other workflows.
This prevents its scheduled runs and notifications on the fork. The safe anchor
takes the standard PR, Mobile Checks, and E2E workflow definitions from the
selected upstream Release and the two maintenance workflows from the current
production fork.

## Protected refs and bootstrap

The scheduled and manual sync workflow does not bootstrap a missing
`upstream-release`. Absence of that ref is ambiguous and fails closed; restore it
explicitly from a verified generated anchor before retrying. Normal maintenance
may move only `fork`, `upstream-release`, and `sync/upstream-release` through the
gated finalizer. `main`, all PR/fix branches, `GhostFlying/large_worktree`, and
`fix/workspace-changed-oversize-resync` must retain their original SHAs.

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
commit's `package.json` contains `X.Y.Z`. Do not infer eligibility from a tag
alone, require a fixed commit-subject convention, or use upstream `main`.

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
  --target=<release-commit>
```

Replay the returned `patchCommits` in order. Skip a patch only when Git proves
it is empty because upstream absorbed it. For a real conflict:

1. Read both the old patch intent and the new upstream implementation.
2. Resolve at the semantic/API level and preserve new upstream behavior.
3. Stage only the intended resolution and continue the cherry-pick so its
   original subject and author remain intact.
4. Run focused tests for the conflicted area before continuing.

The candidate must remain linear and merge-free. Never add a commit that was
not in the captured source range merely because it existed on an old feature or
PR branch. Never use a blanket `ours`/`theirs` resolution.

### 3. Record maintenance changes separately

If the runbook, workflows, or maintenance scripts need to change, put those
changes, and no business code, in one final generated maintenance snapshot
commit with trailer:

```text
Fork-Maintenance-Generated: maintenance-snapshot-v1
```

The snapshot may change only paths recognized by `MAINTENANCE_PATHS`, must be
the final candidate commit, and is excluded from the business patch stack. Do
not weaken linear-history, generated-commit, path-boundary, Release-identity, or
transaction-lease validation to make a candidate pass.

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
   Android build and signing, unsigned iOS, release bundle, and finalizer,
   succeeded.
2. The GitHub Release is a published prerelease, targets the candidate SHA, and
   contains exactly the asset set described in `build-metadata.json` plus
   `checksums.txt`; downloaded hashes verify.
3. `fork` and `sync/upstream-release` equal the candidate SHA, and
   `upstream-release` equals its generated anchor SHA.
4. The fork tag resolves to the candidate SHA.
5. Every protected PR/fix branch SHA equals the value captured before recovery.
6. No unrelated workflow was enabled and the working tree is clean.

## Why patches remain commits in this repository

An external patch repository could make the queue independent from replayed
commit SHAs and could store explicit per-upstream-version patch manifests. It
would also add a second repository and revision to every transaction, require
atomic coordination between patch data and maintenance code, make individual
patches non-buildable until applied, and make rename/context drift plus binary
changes harder to review and test.

Keeping real commits in `upstream-release..fork` gives each patch a native diff,
parent, author, tests, bisect point, and GitHub review history. Its cost is that
every replay changes commit SHAs and conflict resolution still requires semantic
review. The range-based model accepts that cost and deliberately does not treat
those changing SHAs as durable identity. Reconsider an external patch repository
only if the queue must be shared across several forks or maintained independently
of a buildable Orca branch; if adopted, pin the patch repository revision as a
transaction input, not each generated target commit.
