# Mixed daemon census during controlled updates

The runtime already authenticates inventories from every daemon generation, but collapses two known protocols to an unknown single protocol. Add an optional complete protocol set while keeping the legacy single field. Update planning checks every reported protocol; unknown/missing facts and in-process terminals remain refused.

For the first update from a server that omits the set, qualify operator-collected authenticated per-daemon inventories only behind the existing terminal-admission fence. Require unchanged runtime identity, unchanged fenced census before/after, no in-process terminals, complete generation identity coverage, unique session identities, an exact session count match, and an unexpired fence. The operator adapter gathers facts; core qualification and the normal update planner retain authority. The new server subsequently reports complete protocol sets directly. No daemon/session termination is part of this change.

Test mixed supported and unsupported versions, missing inventories, conflicting single/set fields, stale fences, runtime replacement, duplicate sessions and count changes. Review independently and release only through the normal leased hotfix and complete build gates. If the old host cannot supply every required fact, do not deploy it.

The legacy bootstrap is a separately reviewed operator adapter for this controlled migration, not automatic discovery in the desktop updater. An unqualified legacy response continues to defer in every normal caller. Do not describe this change as automatically upgrading old mixed-generation servers.

Independent bootstrap review also reproduced unconfirmed remote census termination being swallowed as an ordinary unavailable count. Preserve that existing typed transport error through fenced recount so the normal activation lock retains ownership while remote work may still run; do not reopen admission or stop the runtime. Ordinary confirmed count failures continue to defer and reopen as before. Add a fault regression for both outcomes before the next candidate.
