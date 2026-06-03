# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use one of the following private channels:

- **GitHub Security Advisories** — open a private report via the repository's
  **Security → Advisories → Report a vulnerability** tab (preferred).
- **Email** — **dev@motionlabs.kr**

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (a proof of concept if possible)
- Affected version(s) / commit
- Any suggested mitigation

We aim to acknowledge reports within **3 business days** and to provide a
remediation timeline after triage. Please give us a reasonable window to release
a fix before any public disclosure.

## Supported Versions

This project is pre-1.0 and ships frequently; security fixes target the
**latest released version**. Please upgrade to the newest release before
reporting.

## Scope notes

Rebase is a local-first desktop app: database credentials are stored in the OS
keychain and the engine runs on `127.0.0.1`. Reports about credential handling,
the local engine's HTTP surface, the auto-update flow, or the agent tool
sandbox are especially welcome.
