# Fork server template packaging repair

## Goal

Rebuild the v1.4.229 fork with its complete managed-server deployment template,
publish through the existing candidate gate, and verify the installed Mac and SSH
connection. Preserve business patches, versions, signing policy and remote wire
contracts. Keep the prior release and local stash recoverable.

## Implementation

1. Generate a call-only fork workflow from the selected upstream Release's
   node-server-tests.yml. Retain its qualification, native slots, mobile web
   assets, merge and template build. Force complete qualification for template
   callers, including callers whose inherited event is a maintenance-only push.
2. Pass the exact validated candidate SHA and build_template=true. Require the
   template before all five desktop packages, download it from this run, and set
   ORCA_REQUIRE_ORCAD_TEMPLATE=1. Keep all template jobs read-only and secret-free.
3. Regenerate the workflow at each upstream anchor; preserve it for hotfixes.
   Register generation, verification and tests in every maintenance allowlist.
4. Reuse upstream content verification after packing every desktop app. Verify
   templates in extracted macOS ZIP/DMG apps alongside complete ad-hoc signatures.
5. Cover generation determinism, complete qualification, artifact provenance,
   ordering, failure propagation, missing/corrupt template contents, and future
   sync/hotfix preservation. Update the maintenance runbook.

## Release and acceptance

Run maintenance and focused upstream tests, lint and diff checks. Capture current
production and protected-ref leases, rebuild a same-version upstream-sync
transaction with the unchanged business stack and one final maintenance snapshot,
and push only the leased sync/upstream-release candidate. Require every desktop,
mobile and finalizer job to pass; verify release assets, checksums and exact refs.
Back up the installed app and profile before normal installation. Verify template
contents and SSH-managed-server terminal execution without stopping live or
unverifiable remote terminals. Return the checkout to the promoted fork.
