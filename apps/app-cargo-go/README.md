# Acurast Example App: Go (cargo / Shell runtime)

> 📖 **Docs / full walkthrough:** [Run Any Language on Acurast (Go)](https://docs.acurast.com/developers/examples/languages#go)

Runs a minimal **Go** program in the Acurast **Shell** runtime (a Cargo
deployment): an Ubuntu `proot-distro` rootfs where the Go toolchain is
installed at startup, then the program runs and POSTs a small JSON payload to
your `WEBHOOK_URL`. One of a set of single-language examples
(`app-cargo-go`, `app-cargo-rust`, `app-cargo-php`, `app-cargo-nodejs`,
`app-cargo-ruby`, `app-cargo-python`, `app-cargo-java`, `app-cargo-cpp`,
`app-cargo-csharp`) showing that any language runs on Acurast.

## How it works

- `acurast.json` declares `runtime: "Shell"` and an Ubuntu `proot-distro`
  image; `fileUrl` is the `app/` dir and `entrypoint` is `start.sh`.
- `start.sh` sets up `PATH`/`HOME`/DNS, installs `golang-go` via `apt-get`,
  then runs the program with `go run`.
- `main.go` builds a JSON body (`language`, `runtime`, `message`) and POSTs it
  to `WEBHOOK_URL` (with a `/go` subpath for attribution) using `net/http`.

## Setup

```bash
cp .env.example .env   # set ACURAST_MNEMONIC and WEBHOOK_URL
npm i
npm run deploy
```

## Notes

- Uses Go's standard `net/http` client — no external modules.
- Built with `CGO_ENABLED=0` so Go uses its pure-Go DNS resolver and runtime —
  the minimal rootfs has no C toolchain/headers (`stdlib.h`), which cgo needs.
- `start.sh` also POSTs `status` reports to the webhook (`startup`, `done`, and
  `error` with the stage, exit code, and a stderr tail) so failures are visible
  — the processor's stdout/stderr isn't otherwise accessible. This is **not
  required**: the program already POSTs on success. To get a minimal example,
  remove the marked debug block, the `report`/`fail` calls, and the
  `apt-get install -y curl` line in `start.sh`.
