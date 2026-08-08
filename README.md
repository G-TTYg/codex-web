# codex-web

a browser frontend for codex desktop, running on a machine you control.

https://github.com/user-attachments/assets/0a33cbd8-741c-412c-9e75-46dfe9324596

## motivation

the agents were never meant to stay trapped in a terminal window for long.
codex desktop brought the power of agents to your local computer, where your
files, credentials, and tools already live.

codex-web brings codex desktop to the browser while keeping the backend on a
machine you control (a linux box in the cloud, your home lab, or a desktop / mac
mini). agents keep running after your laptop closes. you can reconnect from any
device with a browser.

this project aims to be as thin a wrapper as possible to ensure upstream changes
to the codex desktop app can be integrated quickly.

## compatibility

codex-web currently supports macOS, Linux, and Windows hosts with these pinned
defaults:

| component               | version                      |
| ----------------------- | ---------------------------- |
| desktop renderer / ASAR | `26.730.61639`               |
| electron contract       | `42.3.0`                     |
| Windows Store package   | `OpenAI.Codex 26.730.8199.0` |
| Codex CLI               | `0.147.0-alpha.1.2`          |

the Windows package version, ASAR version, Electron version, and CLI version are
separate compatibility layers. Windows and macOS can also contain different
minified builds with the same ASAR version. the shared semantic patcher verifies
both supported source forms and stops if no known form matches.

defaults and download integrity values live in
[`scripts/runtime-versions.json`](./scripts/runtime-versions.json). the managed
CLI is independent of a separately installed `codex` binary, but still uses the
host's normal account, configuration, and data directories.

## usage

`codex-web` serves the browser client and hosts the desktop-side bridge. by
default, it listens on `127.0.0.1:8214`.

run it directly from Git on any supported host:

```bash
npx --yes github:0xcaff/codex-web
```

or with nix:

```bash
nix run github:0xcaff/codex-web
```

then open <http://127.0.0.1:8214> in a browser.

for a local checkout, every host uses the same public build and server commands:

```bash
git clone https://github.com/0xcaff/codex-web.git
cd codex-web
npm install
npm run server
```

`npm install` runs the platform-aware build. macOS and Linux download the pinned
official macOS desktop archive as the renderer source. Windows uses an already
installed exact `OpenAI.Codex` Microsoft Store package when available;
otherwise it downloads the pinned x64 or arm64 Store MSIX and extracts it into
ignored project state. all three hosts download and verify the pinned CLI for
their OS and architecture.

for development, install dependencies without the lifecycle build and invoke
the same build entry explicitly:

```bash
npm ci --ignore-scripts
npm run build
npm run server
```

set `HOSTED_CODEX_APP_ZIP` to an existing official archive or `CODEX_CLI_PATH`
to an explicit CLI when an override is required. `CODEX_WEB_DOWNLOAD_PROXY`
routes managed CLI downloads on every host and managed Windows Desktop MSIX
downloads through a proxy.

### Windows Desktop source overrides

the ordinary Windows entry remains `npm run build`. it prefers an exact
installed Appx, then uses the architecture-specific pinned MSIX. the historical
MSIX URL may use a byte-preserving release mirror as transport, but the mirror
is not trusted: the build requires the Microsoft Store Catalog size and
SHA-256, a valid Windows package signature from the pinned Store publisher,
the exact Appx identity/version/architecture, and the pinned ASAR, brand, and
Electron metadata before accepting it. direct invocation of the internal
adapter is only needed to test a non-default Desktop source:

```powershell
# Build from an explicitly supplied official ASAR.
powershell -File .\scripts\windows\setup.ps1 `
  -AppAsarPath C:\path\to\app.asar `
  -AppAsarUnpackedPath C:\path\to\app.asar.unpacked `
  -AppResourcesPath C:\path\to\Resources

# Explicitly test the newest installed Store package instead of the pin.
powershell -File .\scripts\windows\setup.ps1 `
  -UseNewestInstalledDesktop

# Route managed downloads through a proxy.
powershell -File .\scripts\windows\setup.ps1 `
  -DownloadProxy http://127.0.0.1:7897
```

Verified MSIX archives are cached under `scratch/downloads/`; their atomically
extracted package trees stay under `scratch/desktop-packages/`. both paths are
ignored and must not be committed. Windows never substitutes a newer installed
or remotely discovered Store version for the manifest pin.

### sign in

ensure the Codex account is signed in on the host before starting the server.
the managed CLI shares the normal Codex home directory.

```bash
codex login --device-auth
```

### network exposure

loopback is the safe default. the shared server entry can bind specifically to
the current Tailscale IPv4 address on macOS, Linux, or Windows:

```bash
npm run server -- --prefer-tailscale
```

non-default Tailscale installations and profiles are supported:

```bash
npm run server -- --prefer-tailscale \
  --tailscale-path /path/to/tailscale \
  --tailscale-socket /path/to/tailscaled.sock \
  --tailscale-ipv4 100.64.0.10 \
  --tailscale-dns-name my-host.example.ts.net
```

PowerShell users can place the arguments on one line or replace each `\` with a
backtick. `--prefer-tailscale` fails closed when no usable Tailnet address is
found. the same server command also supports a custom host and port:

```bash
npm run server -- --host 0.0.0.0 --port 9000
```

an optional shared-password gate can protect every page, host-file response,
upload, and WebSocket connection. set the password in the server environment;
it is never embedded in the browser bundle:

```bash
CODEX_WEB_AUTH_PASSWORD='replace-with-a-strong-password' \
  npm run server -- --prefer-tailscale
```

```powershell
$env:CODEX_WEB_AUTH_PASSWORD = 'replace-with-a-strong-password'
npm run server -- --prefer-tailscale
```

the login dialog exchanges the password for an HttpOnly, SameSite=Strict
session cookie. sessions expire when the browser session ends or the server is
restarted. leaving `CODEX_WEB_AUTH_PASSWORD` unset preserves the unauthenticated
local-development behavior.

binding `0.0.0.0` exposes the server on every host interface, including LAN,
Tailscale, and potentially public interfaces. prefer a specific Tailnet
address, the built-in password gate, or an authenticated reverse proxy.

### proxying to app-server (advanced usage)

it's often useful to run the app server separately, so a crash or restart of
codex-web doesn't interrupt the codex process executing commands.

it's possible to hook codex-web up to an already-running app server using the
`codex_remote_proxy` script.

start a long-lived app server somewhere:

```bash
mkdir -p /tmp/codex-app-server
cd /tmp/codex-app-server
codex app-server --listen unix://codex-app-server.sock
```

then run `codex-web` with the proxy helper:

```bash
nix shell github:0xcaff/codex-web github:0xcaff/codex-web#codex_remote_proxy -c bash -lc '
  export CODEX_UNIX_SOCKET=/tmp/codex-app-server/codex-app-server.sock
  export CODEX_CLI_PATH="$(command -v codex_remote_proxy)"
  codex-web
'
```

`codex app-server proxy --sock ...` is a raw stdio protocol bridge for another
program to use; when run directly in a terminal it will wait for protocol input
rather than opening an interactive prompt.

## security

run `codex-web` only on trusted networks. unless the password gate or an
external authentication gateway is enabled, treat anyone who can reach the
server as someone who can operate Codex on the host machine as the same user
running the server.

the built-in gate is intentionally a single-user shared-password check, not
multi-user authorization. use an external identity-aware proxy when individual
accounts, revocation, audit logs, or role-based access are required. ordinary
HTTP does not add transport encryption; use a Tailnet, HTTPS reverse proxy, or
SSH tunnel so the password and session cookie are not sent across an untrusted
network in plaintext.

someone with access to the web UI may be able to:

- run commands on the host, limited only by the permissions of the `codex-web`
  server process.
- read or modify files, environment variables, credentials, ssh keys, and other
  local resources that are accessible to that process.
- use the codex / chatgpt account already signed in on the host. this may
  consume usage quota or billing credits, and may expose account metadata shown
  by the app or CLI, such as name or email address.

## features

- hostable on macOS, Linux, and Windows
- reachable from the browser
- thin wrapper, so updates should land fast
- working today:
  - subagents and app-host MessagePort forwarding
  - host-native terminal sessions
  - Codex Micro discovery and control through host-native `node-hid` and
    `serialport`
  - the official standalone Computer Use Node runtime on Windows and macOS
  - inline images
  - editor sidepanel
  - transcription
  - a capability-detected touch interaction layer for phones, iPads, and
    hybrid touchscreens, with renderer-owned inline menu controls, the original
    renderer context menus, native scrolling, touch-disabled dragging, and
    keyboard-dismiss-safe search

The platform build copies Computer Use and native-resource assets only from the
same official Desktop Resources directory used for extraction. Electron-native
addons are retained for compatibility auditing, but the plain-Node server uses
host-native packages or upstream fallbacks where an addon is linked directly to
Electron. Windows device attestation already uses the upstream non-addon signal
path; macOS-only hardware attestation remains limited by that Electron runtime
boundary.

## development and upgrades

source builds use the same platform-aware preparation pipeline:

```bash
npm ci --ignore-scripts
npm run build
npm run server
```

generated desktop files remain under ignored `scratch/` paths and are never
committed. see [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the extraction,
patching, and runtime design. see [`UPGRADING.md`](./UPGRADING.md) for the
desktop compatibility upgrade procedure.

## roadmap

some parts of the desktop experience are not wired up yet:

- browser panel support, likely rebuilt around iframes
- computer use on linux, which could become a very powerful feature
- git worker integration
- whatever else people find and file issues for

## issues welcome

if something is broken, missing, or rough around the edges, please file an
issue.

using `codex-web` in an interesting way? post about it on x and tag me
[@0xcaff](https://x.com/0xcaff).

using this at a company and need something more tailored? email me and we can
talk.

## alternatives

- [davej/pocodex](https://github.com/davej/pocodex) i used this until the wheels
  fell off. i needed subagents and an inline image viewer. this didn't have them
  and was having a hard time keeping up with upstream codex updates.
- the native codex remote feature (behind a feature flag) is great for
  connecting to remote codex hosts over ssh to manage long running tasks but
  this only works if you have codex desktop on your client device. this means it
  doesn't work on mobile.
- upcoming first party mobile app from openai. `codex-web` exists and works
  today. i can't wait for the mobile app but judging by the other openai mobile
  apps, i'm a little bit skeptical about the quality of the mobile experience.
  time will tell.
