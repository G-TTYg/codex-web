# codex-web

Run the Codex Desktop workspace UI in a browser while the Codex process, files,
credentials, and tools stay on a machine you control.

This fork tracks the current ChatGPT-branded Codex Desktop renderer and supports
macOS, Linux, and Windows hosts. It builds on
[`0xcaff/codex-web`](https://github.com/0xcaff/codex-web) and ports the useful
Windows behavior from
[`Yiruma96/codex-web`](https://github.com/Yiruma96/codex-web) without replacing
newer upstream IPC and MessagePort fixes.

## Compatibility

The current compatibility target is:

| Component                                   | Version verified on 2026-08-06 |
| ------------------------------------------- | ------------------------------ |
| Desktop renderer / ASAR                     | `26.730.61639`                 |
| Electron contract                           | `42.3.0`                       |
| Windows Store package used for verification | `OpenAI.Codex 26.730.8199.0`   |
| Codex CLI bundled by Nix                    | `0.147.0-alpha.1.2`            |

The Windows Appx version, ASAR version, Electron version, and Codex CLI version
are separate version layers. A newer installed Desktop package is accepted only
when every semantic patch still matches exactly; the build stops instead of
silently producing a partially patched app.

## Requirements

- Node.js 22.12 or newer and npm.
- A signed-in Codex CLI (`codex login --device-auth`).
- Windows: the current ChatGPT-branded Codex workspace app from Microsoft
  Store, unless an explicit `app.asar` is supplied.
- macOS/Linux source builds: Bash, `curl`, and `unzip`.

## Windows quick start

```powershell
git clone https://github.com/G-TTYg/codex-web.git
cd codex-web
.\setup-windows.ps1
.\start-codex-web.ps1
```

You can also double-click `setup-windows.bat` and then `start-codex-web.bat`.
The setup script discovers the newest installed `OpenAI.Codex` Store package,
extracts only the required files, applies the shared patches, and builds the
browser and server bundles.

Useful Windows options:

```powershell
# Build from an explicitly supplied official ASAR.
.\setup-windows.ps1 -AppAsarPath C:\path\to\app.asar

# Listen on a different local port.
.\start-codex-web.ps1 -Port 9000

# Deliberately expose only on the detected Tailscale address.
.\start-codex-web.ps1 -PreferTailscale

# Non-default Tailscale CLI/socket and an explicit Tailnet address.
.\start-codex-web.ps1 -PreferTailscale `
  -TailscalePath C:\Tools\tailscale.exe `
  -TailscaleSocket C:\path\to\tailscaled.sock `
  -TailscaleIPv4 100.64.0.10 `
  -TailscaleDNSName my-host.example.ts.net
```

The launcher defaults to `127.0.0.1:8214`. It never kills an existing process
that owns the requested port. `-PreferTailscale` fails closed if Tailscale is
offline or its address cannot be determined, so it never silently falls back to
loopback. `-TailscalePath`, `-TailscaleSocket`, `-TailscaleIPv4`, and
`-TailscaleDNSName` support non-default installations and profiles.

## macOS and Linux quick start

```bash
git clone https://github.com/G-TTYg/codex-web.git
cd codex-web
npm ci --ignore-scripts
npm run build
CODEX_CLI_PATH="$(command -v codex)" npm run server
```

Open <http://127.0.0.1:8214>. macOS and Linux use the official macOS Desktop zip
as the renderer source; the renderer is architecture-independent and the Codex
CLI still runs natively on the host.

Nix users can run:

```bash
nix run github:G-TTYg/codex-web
```

To reuse a pre-downloaded official zip, avoid another download:

```bash
HOSTED_CODEX_APP_ZIP=/absolute/path/ChatGPT-darwin-arm64-26.730.61639.zip npm run build
```

## Security

Treat anyone who can reach this server as someone who can operate Codex with
the permissions and account of the host process. They may be able to run
commands, read or modify accessible files and credentials, and consume account
quota.

The server has no built-in authentication. Keep the default loopback binding,
or put it behind a trusted SSH tunnel, VPN, and/or authenticated reverse proxy.
Do not bind it to a public interface without an external access-control layer.

## What works

- Existing and new Codex tasks in a browser.
- Subagents and MessagePort/app-host forwarding.
- Inline images, local file and workspace selection.
- Editor side panel, prompt prefill, browser history, and mobile sidebar fixes.
- Transcription and remote-control feature-gate shims already supported upstream.

Native Electron-only surfaces such as embedded browser panels, terminals,
computer use, and some OS integrations may still require browser-specific work.

## Development

```bash
npm ci --ignore-scripts
npm run build:server
npm run build:browser     # requires a prepared scratch/asar tree
npm run build             # complete platform-aware preparation and build
```

Generated Desktop files live under `scratch/` and are never committed. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for the runtime and extraction design and
[`UPGRADING.md`](./UPGRADING.md) for the Desktop upgrade procedure.

## 中文说明

Windows 用户安装最新版 Microsoft Store 中的 ChatGPT/Codex 桌面应用后，依次
运行 `setup-windows.bat` 和 `start-codex-web.bat` 即可。默认只监听本机
`127.0.0.1:8214`；需要在 Tailnet 内访问时，请显式使用
`start-codex-web.ps1 -PreferTailscale`。非默认安装可追加 `-TailscalePath`、
`-TailscaleSocket`、`-TailscaleIPv4` 和 `-TailscaleDNSName`。macOS/Linux 用户
按上面的 npm 或 Nix 命令构建。任何补丁锚点不匹配都表示上游 Desktop 已变化，
此时应按升级文档适配，不能跳过失败继续运行。
