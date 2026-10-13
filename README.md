# Microbot-Launcher
Microbot Launcher for The Microbot Client

This launcher is licensed under GNU GPL version 3 only. The complete
corresponding source for every distributed Microbot Cut Launcher build must be
offered alongside that build. Keep the source archive produced by the release
workflow next to the installer and retain the upstream copyright notices. See
[`LICENSE`](LICENSE).

## Microbot Cut fork

This fork owns Microbot Cut product authentication, protected local account
storage, the client authorization broker, signed client updates, startup health
acknowledgement, and last-known-good rollback. Run the current staging setup with:

```powershell
npm.cmd run dev:staging
```

Run the private Cut Walker development build with:

```powershell
npm.cmd run dev:walker
```

To load the locally built Remote Guardian instead of the signed plugin catalog:

```powershell
npm.cmd run dev:guardian
```

This command requires a selected client release that contains the
`BreakHandlerV2Status` contract. Staging `cut-2.6.31-p12` is the first signed
candidate that contains it.

Remote Guardian remains a development-only premium candidate until its local
pairing, command authorization, Break Handler status, and shutdown behavior
have passed the acceptance checklist.

This installs the locally built `cut-walker-0.1.6.jar` into the isolated
development plugin directory and disables the remote plugin catalog for that
launcher process. It still uses product authentication and the signed staging
client channel.

Run the production account and stable release profile with:

```powershell
npm.cmd run dev:production
```

The production profile uses the production API and defaults to the independently
signed production client channel. It can still honor an authorized beta cohort,
and the independently signed production plugin repository is enabled after
catalog signature, public artifact hash, Worker catalog, and premium access
control validation. Premium installation, verified-cache loading, entitlement
revocation, and automatic runtime shutdown also passed in production.

The current staging client is `cut-2.6.31-p12`, signed release sequence 15. Its
manifest and public artifact have passed publication verification. Startup
acknowledgement and Remote Guardian integration remain part of the private
acceptance run. Release commands are defined by
`npm.cmd run release:client` and must follow prepare, immutable stage, explicit
promote, and verify.

Staging is currently an operator-selected environment. Server-controlled
stable/beta/internal cohorts are now returned by the backend. Signed staging
release discovery, download, rollback, and launch fail closed unless the
authenticated account is assigned to `beta` or `internal`. Automatic fallback
to the independently signed production channel is implemented. Production
currently serves `cut-2.6.30-r2`, signed recovery sequence 3. The production JAR
contains only the production ticket trust anchor; staging builds contain only
the staging anchor. Production plugins trust only the separate
`production-2026` catalog.

<img width="1915" height="1197" alt="image" src="https://github.com/user-attachments/assets/dfa1f620-ed5a-409c-97f0-f2c6e86e9a8a" />


## Embedded Java runtime

A distributed launcher runs the client only on the Java runtime embedded in its installer (Eclipse Temurin
17, reduced with `jlink`). It never falls back to a Java found on the machine. Licenses and provenance are in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

- **Pin:** `config/java-runtime.json` (version, archive digest, signing key fingerprint, source commits,
  module list, image digest).
- **Build the image** (Windows, `gpg` and `gpgv` on the PATH):
  `node scripts/build-java-runtime.js` downloads the official archive, checks its SHA-256 against the pin and
  the publisher's checksum file, verifies the publisher's signature, runs `jlink` from the archive itself and
  writes `runtime-manifest.json`. It stops on any mismatch. The image goes to
  `.release-work/java-runtime/image`; `--archive`, `--signature` and `--checksum` take local copies. Two
  builds of the same archive give the same `imageSha256`. `--write-pin` records the digest after a reviewed
  runtime change.
- **Embedding:** `package.json` `build.extraResources` copies the image to `resources/java-runtime`. The
  embedded distribution profile pins the Java version and the image digest. `beforePack` and the packed-app
  check both verify the image against that pin.
- **At run time:** before every client start the launcher checks every file of the runtime (name, size,
  SHA-256, no extra files). If anything differs, or the runtime is missing, the client is not started and the
  user is told to reinstall. `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS` and `JDK_JAVA_OPTIONS` are removed from the
  Java child's environment only.
- **Updating Java:** a runtime update is a launcher release. Review each new 17.0.x quarterly (and for high
  severity CVEs), change the pin, rebuild, run the tests and the compatibility checks, then release.

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
For an unsigned local test package:

```powershell
npm.cmd run release:windows:unsigned
```

Production packages must use `npm.cmd run release:windows:production`. That
command requires either PFX credentials (`WIN_CSC_LINK` and
`WIN_CSC_KEY_PASSWORD`) or Azure Trusted Signing configuration, enables
fail-closed code signing, and verifies the Authenticode publisher after the
build. Manifest signing keys are separate and cannot be used for Authenticode.

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


