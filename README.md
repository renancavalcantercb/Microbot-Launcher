# Microbot-Launcher
Microbot Launcher for The Microbot Client

## Microbot Cut fork

This fork owns Microbot Cut product authentication, protected local account
storage, the client authorization broker, signed client updates, startup health
acknowledgement, and last-known-good rollback. Run the current staging setup with:

```powershell
npm.cmd run dev:staging
```

Run the production account and stable release profile with:

```powershell
npm.cmd run dev:production
```

The production profile uses the production API and defaults to the independently
signed production client channel. It can still honor an authorized beta cohort,
but the external plugin repository remains disabled until the independently
signed production plugin catalog is published and verified. Its trust
configuration is staged with `enabled: false` for a fail-closed rollout.

The current staging client is `cut-2.6.30-p17`, signed release sequence 3. It
has passed verified download, startup acknowledgement, and last-known-good
persistence. Release commands are defined by `npm.cmd run release:client` and
must follow prepare, immutable stage, explicit promote, and verify.

Staging is currently an operator-selected environment. Server-controlled
stable/beta/internal cohorts are now returned by the backend. Signed staging
release discovery, download, rollback, and launch fail closed unless the
authenticated account is assigned to `beta` or `internal`. Automatic fallback
to the independently signed production channel is implemented. Production
currently serves `cut-2.6.30-r2`, signed release sequence 2. The production JAR
contains only the production ticket trust anchor; staging builds contain only
the staging anchor. External product plugins remain disabled on production until
the separate `production-2026` catalog is published and verified.

<img width="1915" height="1197" alt="image" src="https://github.com/user-attachments/assets/dfa1f620-ed5a-409c-97f0-f2c6e86e9a8a" />


## Prerequisites
Before you begin, ensure you have the following installed on your machine:
- [Node.js](https://nodejs.org/) (preferably the latest version)
- [npm](https://www.npmjs.com/) (comes with Node.js)
- [Electron](https://www.electronjs.org/)

You can install Electron globally with the following command:

```bash
npm install -g electron
```

## Installation

1) clone the repository

```bash
git clone https://github.com/your-repo/microbot-launcher.git
```

2) navigate to the project directory

```bash
cd microbot-launcher
```

3) install the dependencies

```bash
npm install
```

## Running the project

```bash
npm run dev
```

## Mock Authentication Mode

The launcher now includes an optional in-memory authentication flow that can be enabled for UI testing and demos.

- Set `MOCK_AUTH=1` to activate mock mode. Accounts exist only in memory and reset when the app restarts.
- (Optional) Provide `MOCK_USERS` to preload accounts. Accepts either JSON (e.g. `[{"email":"demo@site.com","password":"Password1"}]`) or a delimited list such as `demo@site.com:Password1,guest@site.com:Password2`.
- Use `MOCK_LATENCY_MS` to simulate network latency (in milliseconds) and `MOCK_FAIL_PCT` to simulate intermittent failures (percentage between 0-100).

When mock mode is disabled, the launcher skips the mock login screen and behaves as before.

## Package for Windows
For 64-bit
```bash
npm run build:x64
```
For 32-bit
```bash
npm run build:ia32
```

## Steps to Contribute:
1. Fork the repository
2.  Create a new branch (git checkout -b feature-branch)
3. Commit your changes (git commit -m 'Add some feature')
4. Push to the branch (git push origin feature-branch)
5. Create a new Pull Request

## Youtube

[![image](https://github.com/user-attachments/assets/f15ec853-9b92-474e-a269-9a984e8bb792)](https://www.youtube.com/channel/UCEj_7N5OPJkdDi0VTMOJOpw)

## Discord

[![Discord Banner 1](https://discord.com/api/guilds/1087718903985221642/widget.png?style=banner1)](https://discord.gg/zaGrfqFEWE)

 
If you have any questions, please join our [Discord](https://discord.gg/zaGrfqFEWE) server.


## ☕ Buy Me a Coffee

If you enjoy my open source work and would like to support me, consider buying me a coffee! Your support helps me stay caffeinated and motivated to keep improving and creating awesome projects.

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-donate-yellow)](https://www.paypal.com/paypalme/MicrobotBE?country.x=BE)

Thank you for your support! 😊


