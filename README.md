# SpoonMate Remote Authorization

This public repository hosts SpoonMate's signed authorization envelope, Ed25519 public key, and public LITE update-version metadata.

Public authorization endpoint:

`https://gisun5689.github.io/spoonmate/authorization-envelope.json`

Public LITE update metadata endpoint:

`https://gisun5689.github.io/spoonmate/lite-update.json`

## Public files

- `authorization-envelope.json`: signed authorization policy consumed by SpoonMate
- `authorization-public-key.pem`: Ed25519 public key used to verify the envelope
- `lite-update.json`: public LITE latest-version metadata used before GitHub Release lookup
- `scripts/verify-authorization.mjs`: strict offline signature and schema verifier
- `.github/workflows/pages.yml`: verifies and publishes the public files to GitHub Pages

`lite-update.json` is version metadata only. A real automatic update is downloadable only after the verified Windows installer, blockmap, and `lite.yml` are published in a GitHub Release.

## Never commit

- Ed25519 private keys or signing bundles
- GitHub tokens, API secrets, passwords, or environment files
- SpoonMate DEV source, encrypted source bundles, or Distribution packages

The Pages workflow does not sign or modify authorization policy. A policy must be signed locally with protected administrator material before `authorization-envelope.json` is replaced.
