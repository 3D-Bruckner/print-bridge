# Security policy

## Reporting a vulnerability

Report it privately through [**Report a vulnerability**](https://github.com/3D-Bruckner/print-bridge/security/advisories/new) on this repository's Security tab. Please do not open a public issue for it.

This covers the service and the image `ghcr.io/3d-bruckner/print-bridge`: what it reads from Home Assistant and writes to Invoice Ninja.

Helpful in a report: the commit or image tag, how the instance is configured as far as it matters, and the steps that show the problem.

You get an answer within seven days. Once a fix is deployed, the advisory is published and names you, unless you would rather not be named.

## Supported versions

Only the newest release gets security fixes.

## How this repository watches for vulnerabilities

- Dependabot alerts and security updates: a pull request for a fixed version as soon as an advisory is known.
- Secret scanning with push protection: a pushed token is refused.
- CodeQL code scanning on every pull request.
- A daily audit of the production dependencies (`.github/workflows/audit.yml`).
