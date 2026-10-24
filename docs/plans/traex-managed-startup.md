# TraeX managed startup hotfix

## Evidence and scope

TraeX 0.211.1 starts an empty composer before its first SessionStart hook. Its animated logo continues to repaint while that composer is ready, so the Trae launcher's default 1500 ms quiet-output readiness gate never settles. The fallback Trae readiness rules contain no startup text anchors. The launcher can consequently return `not-delivered` without starting a turn.

An isolated native PTY probe also confirms that project trust in the launched user's `TRAE_HOME/traecli.toml` accepts the exact starting directory, for both plain directories and linked Git worktrees. A parent directory entry does not suffice. Although the interactive confirmation offers to trust the main checkout, trusting that broader root is unnecessary for a managed worktree.

## Changes

1. Add the Trae workspace trust preset to the existing fresh-launch preflight, honoring the global setting, final launch home and TRAE_HOME. Reuse the Codex TOML trust updater and mutation lane; write the exact canonical starting directory without changing approval or sandbox policy. Preserve ordinary-folder and linked-worktree behavior.
2. Give Trae/TraeX a structural composer signal using its `❯` prompt, final model/status footer, cursor position and completed synchronized frame, anchored to bracketed-paste mode. The provisional inline composer appears before the trust dialog and must not qualify. Reuse the Codex structural scanner while requiring the final footer in inline mode too; keep the existing startup-dialog and foreground-process checks. Do not infer readiness from missing hooks or general inactivity.
3. Cover animated startup, split marker bytes, trust dialogs, shell handoff, final-home configuration, disabled preflight, and exact-directory trust in focused tests. Verify the native startup with an isolated HOME and PTY without submitting a model request.
4. Run focused tests, type checks and changed-file quality checks, then prepare independent review and an atomic commit on a new fix branch from the current production fork. Preserve every existing branch/ref. Publication, the full fork release gate and installation remain with the coordinating agent.

## Boundaries

No production terminal, active task or agent configuration is changed by development probes. Temporary probe directories and PTYs are cleaned. The Tend caller separately handles prompt disposal receipts; this patch does not add blind retries or synthesize hook state.

## Independent review correction

Native review captures exposed that a 36-column pane truncates the question-mark help hint, while `tui.status_line = []` removes the separate model/status row. The final permission footer still carries the stable `shift+tab` shortcut in both layouts. Use that shortcut below the composer, with the completed-frame and cursor requirements, rather than a specific number of footer rows or localized permission text. The preliminary composer only has the question-mark hint and still does not qualify. Cover both layouts with animations enabled and disabled; no quiet-window fallback is added.

## Second review correction

The permission shortcut is also optional: read-only mode omits it and narrower panes truncate it. Retain the original complete footer structure, recognize Trae's painted status row followed by a footer row without depending on their wording, and keep the permission shortcut as an additional marker for single-row footers. Restore Trae's previous bracketed-paste quiet fallback for layouts that expose neither marker; existing dialog and foreground vetoes still apply. Default animated startup and the captured narrow/read-only layouts must resolve by marker. The provisional composer must never produce an immediate marker. Isolate trust-test launch environments explicitly so an inherited TRAE_HOME cannot escape the temporary fixture.
