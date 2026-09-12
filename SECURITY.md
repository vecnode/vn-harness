# Security Policy

**vn-harness** is a personal, MIT-licensed plugin pack for DeepSeek Harness.
It follows a small, deliberately hard surface:

- **No secrets in this repository.** API keys live in your own harness
  settings (`Settings > Models`); neither the plugins nor the installer ever
  read, write, prompt for, or transmit them. `.credentials.yaml` under the
  harness home is never touched.
- **No core patching.** Every plugin is a standard dsh **bundle**
  (`dsh.bundle` + `cordis.patch.yml` + a `dsh.client` browser half). Nothing
  modifies DeepSeek core packages, harness profile internals beyond what
  `dsh plugin` itself does, or any key material. The pack owns its right bar by
  **forking** the shipped bar bundles into this repo and hard-disabling the core
  rows through its own bundle layer - a supported patch form, not a core edit.
  Forks are marked GENERATED and produced by `scripts/sync-vendored.ps1`, so
  what runs is always reviewable in this repository.
- **Pinned dependency line.** The pack is built and installed against exactly
  the harness version pinned in `.dsh-version.json`; installs always run
  through `npx @deepseek-ai/dsh@<pinned>`, never a floating `latest`.
- **Browser bundle runs in the harness's own module sandbox** (module-table
  format, `require("react")`-only, services reached through declared `inject`
  dependencies). It reads files through the harness's own workspace-files
  remote; the only disk I/O the pack itself performs is the editor's
  **authenticated `connection.fetch` routes**, which are confined to the
  session's own workspace root:
  - every path is resolved against that root and **realpath-checked to stay
    inside it** (a path that escapes is refused),
  - reads are strict UTF-8 text only, ≤ 2 MiB,
  - writes are atomic (private temp file renamed over the target) and refuse to
    clobber a file that changed on disk since it was opened (HTTP 409).
  No other path is ever opened, and nothing outside the conversation folder is
  reachable through those routes.
- **Nothing is ever fetched or executed at build/install time** beyond the
  pinned npm packages the installer declares (pnpm under `tools/` is
  bootstrapped locally, no global/admin installs).

## Supported versions

| Component | Supported |
|---|---|
| Repo default branch (`main`) | yes |
| Harness line pinned in `.dsh-version.json` (`0.1.5-rc.1`) | yes |
| Older pins / master APIs | no — upgrade the pin, then re-verify |

## Reporting a vulnerability

If you find a security issue in this pack (a plugin, the installer scripts, or
the build/docs):

1. **Do not open a public issue with exploit details.**
2. Report privately by opening a GitHub issue **without a PoC**, or by direct
   message to the maintainer (vecnode), and include:
   - affected package + version (`.dsh-version.json`),
   - a short description and the impact you observed,
   - steps that reproduce it, if you can share them safely.
3. You will get an acknowledgement; fixes land on `main` as alpha bumps
   (`-alpha.N`), and the issue stays closed until then.

## Hardening expectations

- Plugins stay **alpha** until the owner promotes them; every behavior change
  bumps the version and is re-installed with `-Force` before it is announced.
- The installer is **idempotent** and skips already-installed bundles unless
  forced; uninstall removes the bundle and its patch layer cleanly.
- The pack targets the **web profile only**; it never installs into, or writes
  to, any other harness home.
- Treat this pack as **personal tooling**: do not run it in multi-tenant or
  untrusted environments, and review any new dependency before it is added.
