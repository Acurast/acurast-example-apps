# Acurast Example App: C# (cargo / Shell runtime)

> 📖 **Docs / full walkthrough:** [Run Any Language on Acurast (C#)](https://docs.acurast.com/developers/examples/languages#csharp)

Runs a minimal **C#** program in the Acurast **Shell** runtime (a Cargo
deployment): an Ubuntu `proot-distro` rootfs where the Mono C# compiler and
runtime are installed at startup, then the program is compiled and run and
POSTs a small JSON payload to your `WEBHOOK_URL`. One of a set of
single-language examples
(`app-cargo-go`, `app-cargo-rust`, `app-cargo-php`, `app-cargo-nodejs`,
`app-cargo-ruby`, `app-cargo-python`, `app-cargo-java`, `app-cargo-cpp`,
`app-cargo-csharp`) showing that any language runs on Acurast.

## How it works

- `acurast.json` declares `runtime: "Shell"` and an Ubuntu `proot-distro`
  image; `fileUrl` is the `app/` dir and `entrypoint` is `start.sh`.
- `start.sh` sets up `PATH`/`HOME`/DNS, installs `mono-mcs` + `mono-runtime`
  via `apt-get`, then compiles with `mcs` and runs with `mono`.
- `Main.cs` builds a JSON body (`language`, `runtime`, `message`) and POSTs it
  to `WEBHOOK_URL` (with a `/csharp` subpath for attribution) using
  `HttpWebRequest`.

## Setup

```bash
cp .env.example .env   # set ACURAST_MNEMONIC and WEBHOOK_URL
npm i
npm run deploy
```

## Notes

- Uses **Mono** (`mcs` + `mono`) — lighter to install in the rootfs than the
  full .NET SDK.
- For the demo the TLS certificate check is bypassed so Mono doesn't need a
  synced CA store. Remove that callback in real code.
- Mono's managed DNS resolver fails under proot (`NameResolutionFailure`), so
  `start.sh` pre-resolves the webhook host with libc (`getent`) and pins it in
  `/etc/hosts` before running — Mono then needs no DNS lookup.
- `start.sh` also POSTs `status` reports to the webhook (`startup`, `done`, and
  `error` with the stage, exit code, and a stderr tail) so failures are visible
  — the processor's stdout/stderr isn't otherwise accessible. This is **not
  required**: the program already POSTs on success. To get a minimal example,
  remove the marked debug block, the `report`/`fail` calls, and the
  `apt-get install -y curl` line in `start.sh`.
