# Isolated real-NSIS upgrade proof (PREPARED, NOT EXECUTED)

This directory is a review artifact. It is not an active workflow and must not be
run against a developer PC. No manifest containing guessed asset IDs or hashes is
provided. Root must supply the reviewed artifact-manifest.json using the included
schema after the actual v124 candidate draft exists.

## Activation boundary

After root review, place these QA files plus the approved manifest in ci-qa/ of an
approved commit in gisun5689/spoonmate, and place installer-e2e.workflow.yml in
.github/workflows/spoonmate-installer-e2e.yml. Do not push or dispatch until separately
approved. Dispatch requires both the immutable commit and exact manifest SHA-256.
The NSIS QA job needs contents:write to read draft releases; its pinned harness uses GET-only GitHub requests and strips workflow tokens from installer child processes.

The harness refuses anything except a GitHub-hosted Windows image, runneradmin,
manual workflow_dispatch, the exact repository and approved commit. It aborts
before installation if the production app GUID exists in either HKCU/HKLM
registry view, or the known app data, default install path, shortcuts or process
already exist. The production app ID is only used inside that fresh disposable
runner. A local /D=temp installation is NOT isolation.

## Required artifact pins

Each of legacy119, public122 and candidate123 requires: release ID, asset ID,
exact tag/name/size, installer SHA-256, installed main EXE SHA-256, packaged app.asar SHA-256, internal version
and actual Authenticode status. All properties are schema-checked. Release 119
must remain a draft, 123 must be the currently published latest release and 124
must remain a draft. Protected DEV code, account information and tokens are not
part of this manifest or the scripts.

Only the workflow's GITHUB_TOKEN environment variable authenticates requests to
api.github.com. Asset redirects are validated and followed using a separate
client with no authorization header. URLs, redirect query strings and credentials
are never written to proof.

## Five mandatory cases, no skips

1. Actual 119 installation followed by actual 124 silent upgrade; exact version,
   main EXE and app.asar hashes, registry target and synthetic user-data sentinel verified.
2. Actual 124 uninstall; installation/registry removed and sentinel retained.
3. Actual 119 old uninstaller copied outside the install root and run with the
   same update/data-preservation arguments while app.asar denies delete sharing.
   Exit 2 and the exact restored old-file manifest are mandatory.
4. Release the synthetic file lock, rerun actual 124 installation, require exit 0
   and verify the exact new version/hash and unchanged sentinel.
5. Actual final uninstall with the same strict checks.

The lock case invokes the real old uninstaller directly. It deliberately does
not automate the parent installer's modal error dialog; that dialog/launcher
handoff is a separate, unclaimed test. The registry key and actual file removal
are still exercised by the same real NSIS uninstaller.

## Scope of proof

This suite never launches SpoonMate, never passes --force-run and never uses an
owner account or license. Assisted silent NSIS only launches the application
when force-run is explicitly requested. The downloaded public 123 bytes are
verified, but actual 119 startup-auto-update to 123 is NOT exercised or claimed:
that needs an independently approved way to guarantee zero provider calls.

A successful summary requires exactly five passed cases, zero failed cases and
zero skipped cases. The app runtime, physical audio, OAuth, server events and
real-user data are not proven by this installer-only suite.

The installation path has the exact Unicode/spaces shape
OneDrive/바탕 화면/SpoonMate LITE v2.0.15.32 under the unique RUNNER_TEMP fixture.
It is a directory-name/path-shape test only. The harness does not start, configure
or verify a real OneDrive sync client and cannot prove provider-specific sync
locking. The held app.asar handle is a deliberately synthetic lock.

Cleanup kills only process handles or validated executable paths created under
the unique runner fixture root. It never kills by product name or calls a
production installer, registry cleanup or AppData cleanup on a local computer.
Only sanitized JSON summaries and installed relative-file hashes are uploaded;
no executable, app.asar, token, raw user data or full environment is uploaded.

## Preparation verification

Use the PowerShell parser only to inspect syntax locally. Do not invoke the
harness locally. No actual installer execution is counted until the reviewed
GitHub-hosted job finishes and its strict summary is checked.

Official NSIS exit-level reference:
https://nsis.sourceforge.io/Docs/AppendixD.html


