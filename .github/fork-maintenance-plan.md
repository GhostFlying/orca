# Fork maintenance plan

## Goal

Maintain the production fork as a linear patch stack:

```text
fork = safe-upstream-anchor + fork-only commits
safe-upstream-anchor^ = adopted upstream main SHA
```

Clean upstream updates promote automatically after validation. Conflicts, failed
checks, or stale source refs leave the production refs unchanged.

## Branches

- `upstream-main` is a generated safe-anchor commit. Its single parent is the
  exact adopted upstream commit, while its tree restores the trusted
  maintenance files and workflow allowlist.
- `fork` is the production source branch and contains only `upstream-main`
  followed by fork-only commits and at most one generated maintenance-snapshot
  commit.
- `sync/upstream-main` is the single generated preview branch for the newest
  attempted upstream target.

The maintenance workflow must reject merge commits in
`upstream-main..fork`. Upstream history is never merged into `fork`; fork-only
commits are replayed in order onto a pinned upstream commit.

## Synchronization

1. Serialize all maintenance runs in one non-cancelling concurrency group.
2. Fetch and pin the current `upstream-main`, `fork`, and upstream `main` SHAs.
3. Verify that `upstream-main` is an ancestor of `fork` and that the fork patch
   stack contains no merge commits.
4. Create a safe anchor whose parent is the pinned upstream target and whose
   maintenance files match production.
5. Replay `upstream-main..fork` onto that safe anchor with baseline-compatible
   `cherry-pick`, explicitly skipping commits that become empty.
6. Restore all maintenance files exactly from production before publishing.
   This prevents upstream workflow or maintenance-script changes from running
   on maintenance refs.
7. Publish `sync/upstream-main` with the preview SHA observed during the initial
   fetch as its exact force-with-lease constraint. The preview is not opened as
   a pull request because a same-repository PR is not a trust boundary.
8. Run fork validation against the exact preview SHA without write credentials.
9. Re-fetch all maintenance refs and promote only if every pinned source ref
   and the preview head still match.
10. Atomically update `fork` to the validated preview and `upstream-main` to the
    safe anchor with exact force-with-lease constraints.

The upstream repository may advance while validation runs. That does not make a
pinned target stale; a later maintenance run adopts the newer upstream commit.

## Failure handling

- A replay conflict publishes the last clean replay state and records the
  failed commit and conflicted paths in the workflow summary.
- A validation failure leaves `fork` and `upstream-main` unchanged.
- Any source-ref or preview-head drift rejects promotion.
- Re-running the workflow replaces the single preview branch only when its
  current head matches the fetched lease.

Conflict resolution remains manual. Automated conflict-resolution agents are
outside this phase.

## Workflow policy

Only these workflows remain enabled in the fork:

- `fork-sync.yml`
- `pr.yml`
- `mobile.yml`
- `e2e.yml`

The maintenance workflow enforces this repository-level allowlist after every
run. Newly inherited upstream workflows therefore default to disabled instead
of gaining scheduled, push, release, or privileged triggers in the fork.
The generated preview also carries the production workflow snapshot, so policy
enforcement is defense in depth rather than a post-push security boundary.

## Credentials

Git ref publication uses one repository-scoped write deploy key stored as
`FORK_MAINTENANCE_SSH_KEY`. The key is injected only into each write job's final
push step, after all repository content has run, and cannot call GitHub APIs,
manage Actions, or access another repository. Validation jobs never receive it.
Workflow policy uses the per-job `GITHUB_TOKEN` with only `actions: write`.

## Bootstrap order

1. Commit and locally validate the maintenance implementation.
2. Disable all workflows outside the allowlist while `main` is still the
   default branch.
3. Create `upstream-main` as a safe anchor over the current upstream boundary
   and create `fork` from the maintained patch stack after restoring trusted
   maintenance files.
4. Install the repository-scoped write deploy key and its private-key secret.
5. Change the default branch to `fork`.
6. Verify the allowlist state, then dispatch one pinned maintenance run.
7. Verify conflict preservation or clean automatic promotion before relying on
   the hourly schedule.

## Phase-one validation

The preview must pass:

- fork-maintenance invariant and workflow contract tests
- lint
- typecheck
- unit tests
- desktop build
- cross-version wire compatibility against the latest stable tag fetched
  read-only from the official upstream repository

Unit-test jobs restore disabled workflow files from the pinned upstream target
only as read-only fixtures; preview and production refs retain the allowlist.

The first rollout must also demonstrate a no-op repeat, a clean automatic
promotion, a source-ref lease rejection, and a conflict that leaves production
refs unchanged.
