# SpoonMate Remote Authorization

This public repository hosts only the signed SpoonMate authorization envelope and its Ed25519 public key.

Public endpoint:

`https://gisun5689.github.io/spoonmate/authorization-envelope.json`

## Public files

- `authorization-envelope.json`: signed authorization policy consumed by SpoonMate
- `authorization-public-key.pem`: Ed25519 public key used to verify the envelope
- `scripts/verify-authorization.mjs`: strict offline signature and schema verifier
- `.github/workflows/pages.yml`: verifies and publishes the public files to GitHub Pages

## Never commit

- Ed25519 private keys or signing bundles
- GitHub tokens, API secrets, passwords, or environment files
- SpoonMate DEV source, encrypted source bundles, or Distribution packages

The Pages workflow does not sign or modify authorization policy. A policy must be signed locally with protected administrator material before `authorization-envelope.json` is replaced.

