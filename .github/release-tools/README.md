# Lite: keep only the verified newest release public

This is release tooling, not application code. It never starts, installs, closes or restarts SpoonMate, and never opens a production user profile.

## Automatic publication path

1. Publish a protected Lite release with exactly its installer, installer blockmap, `lite.yml`, and `SpoonMate_LITE_Update_Release_Manifest.json`.
2. Publish `lite-update.json` through the existing Pages/authorization workflow.
3. After **Build, verify and publish SpoonMate authorization** finishes successfully on trusted `main`, **Verify Lite update and archive older releases** starts automatically.
4. The new task verifies the actual newest release, the public Pages gate, all four public downloads and hashes, and the real Windows NSIS updater's version detection.
5. Only after these checks pass are strictly older public releases changed to drafts. Assets and Git tags are retained.

An unrelated authorization-list update may also start the hook. With no older public release to archive it finishes without downloading the installer again, unless the operator requests a full current-release verification.

## Failure rules

- A failure before cleanup sends **zero** draft mutations. The old public releases remain available.
- A concurrent newer release, mismatched Pages gate, incorrect asset, or updater detection failure stops cleanup.
- Each older release is rechecked immediately before changing its draft flag.
- Partial cleanup never hides the newest release. It saves partial-failure evidence; run the same task again after fixing the cause.
- Already-draft releases are not republished or rewritten. A rerun is safe.
- Do not automatically republish old drafts as a rollback: that could undo an operator's privacy decision.
- Never change repository visibility, General distribution, files, tags, authorization keys, or the running application from this task.

The workflow uses a job-scoped GitHub token with `contents: write`; it needs no new personal token or application login. Only trusted `main` is checked out. Upstream build artifacts and pull-request code are not executed.

GitHub App tokens do not always include a user-style `permissions.push` flag in repository metadata. That optional display field is not used as an authorization decision. GitHub enforces the actual `contents: write` permission on every draft PATCH; a denied write stops the run without marking it successful.

## Operator checks

Open GitHub **Actions → Verify Lite update and archive older releases**. Green means the recorded policy checks succeeded. A red run is not a complete promotion; inspect its retained `lite-release-retention-…` artifact.

For recovery, use **Run workflow** on `main`. Normally leave the tag blank to use the current Lite gate. Specify an expected tag to fail closed if another version has become current. `verify_current=true` performs full public download and actual updater checks even if every old release is already a draft.

For the local protected-build checkout:

```powershell
npm run test:release-retention
npm run release:lite:finalize -- --apply --output "C:\absolute\fresh-attempt-directory" --wait-seconds 900
```

The local finalizer binds its target to the Lite package's display version. Without `--apply` it is read-only. A fresh evidence directory is required; never write new reports into a previously audited release-assets directory.

## Limits and preserved updater behavior

- Drafts are visible to accounts with repository write permission, but not to ordinary public visitors.
- This hides historical **release downloads**, not public Git history or tag source archives.
- A previous version's blockmap may become unavailable. The existing updater falls back to the complete newest installer; no installed-app updater code is changed here.
- Download/hash verification and updater detection are not installation, restart, or real-user app acceptance tests.
- Historical completed publication scripts and PASS reports stay immutable. Do not rerun an old script that required a now-hidden preceding release to be public.
