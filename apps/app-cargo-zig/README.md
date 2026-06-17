# Acurast Example App: Zig (cargo / Shell runtime)

Runs a minimal **Zig** program in the Acurast **Shell** runtime (a Cargo
deployment): an Ubuntu `proot-distro` rootfs where the Zig toolchain is fetched
at startup, then the program is compiled and run and POSTs a small JSON payload
to your `WEBHOOK_URL`. One of a set of single-language examples
(`app-cargo-go`, `app-cargo-rust`, `app-cargo-php`, `app-cargo-nodejs`,
`app-cargo-ruby`, `app-cargo-python`, `app-cargo-java`, `app-cargo-cpp`,
`app-cargo-csharp`, `app-cargo-zig`) showing that any language runs on Acurast.

## How it works

- `acurast.json` declares `runtime: "Shell"` and an Ubuntu `proot-distro`
  image; `fileUrl` is the `app/` dir and `entrypoint` is `start.sh`.
- `start.sh` sets up `PATH`/`HOME`/DNS, installs `libcurl4-openssl-dev`, fetches
  the official Zig prebuilt tarball, then compiles with `zig build-exe` and runs
  the binary.
- `main.zig` builds a JSON body (`language`, `runtime`, `message`) and POSTs it
  to `WEBHOOK_URL` (with a `/zig` subpath for attribution) using libcurl via
  Zig's C interop (`@cImport`).

## Setup

```bash
cp .env.example .env   # set ACURAST_MNEMONIC and WEBHOOK_URL
npm i
npm run deploy
```

## Notes

- Zig isn't reliably packaged in apt, so `start.sh` downloads the official
  `aarch64` prebuilt from ziglang.org (pinned via `ZIG_VERSION`). The proot
  image is `aarch64`, so the `linux-aarch64` build matches.
- Calls libcurl through Zig's C interop rather than `std.http.Client`: the C
  binding is stable across Zig releases, while the `std.http` API changes often.
- `start.sh` also POSTs `status` reports to the webhook (`startup`, `done`, and
  `error` with the stage, exit code, and a stderr tail) so failures are visible
  — the processor's stdout/stderr isn't otherwise accessible. This is **not
  required**: the program already POSTs on success. To get a minimal example,
  remove the marked debug block, the `report`/`fail` calls, and the
  `apt-get install -y curl` line in `start.sh`.
