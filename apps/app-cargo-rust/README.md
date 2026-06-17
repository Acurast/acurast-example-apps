# Acurast Example App: Rust (cargo / Shell runtime)

Runs a minimal **Rust** program in the Acurast **Shell** runtime (a Cargo
deployment): an Ubuntu `proot-distro` rootfs where the Rust toolchain is
installed at startup, then the program is built and run and POSTs a small JSON
payload to your `WEBHOOK_URL`. One of a set of single-language examples
(`app-cargo-go`, `app-cargo-rust`, `app-cargo-php`, `app-cargo-nodejs`,
`app-cargo-ruby`, `app-cargo-python`, `app-cargo-java`, `app-cargo-cpp`,
`app-cargo-csharp`) showing that any language runs on Acurast.

## How it works

- `acurast.json` declares `runtime: "Shell"` and an Ubuntu `proot-distro`
  image; `fileUrl` is the `app/` dir and `entrypoint` is `start.sh`.
- `start.sh` sets up `PATH`/`HOME`/DNS, installs `build-essential` via `apt-get`
  (compiler, linker, libc dev/crt objects) and the current stable Rust toolchain
  via `rustup`, then builds and runs the crate with `cargo run --release`.
- `src/main.rs` builds a JSON body and POSTs it to `WEBHOOK_URL` (with a
  `/rust` subpath for attribution) using the `ureq` HTTP client.

## Setup

```bash
cp .env.example .env   # set ACURAST_MNEMONIC and WEBHOOK_URL
npm i
npm run deploy
```

## Notes

- The crate depends on `ureq` (a small blocking HTTP client with TLS). The
  first build downloads and compiles it inside the rootfs, so allow extra time.
- Rust is installed via `rustup` (current stable), **not** the apt `rustc`: the
  apt version (1.85) is too old for some transitive deps of `ureq`
  (`icu`/`idna` need rustc 1.86+).
- `start.sh` also POSTs `status` reports to the webhook (`startup`, `done`, and
  `error` with the stage, exit code, and a stderr tail) so failures are visible
  — the processor's stdout/stderr isn't otherwise accessible. This is **not
  required**: the program already POSTs on success. To get a minimal example,
  remove the marked debug block, the `report`/`fail` calls, and the
  `apt-get install -y curl` line in `start.sh`.
