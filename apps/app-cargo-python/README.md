# Acurast Example App: Python (cargo / Shell runtime)

> 📖 **Docs / full walkthrough:** [Run Any Language on Acurast (Python)](https://docs.acurast.com/developers/examples/languages#python)

Runs a minimal **Python** program in the Acurast **Shell** runtime (a Cargo
deployment): an Ubuntu `proot-distro` rootfs where the Python `requests`
library is installed at startup, then the program runs and POSTs a small JSON
payload to your `WEBHOOK_URL`. One of a set of single-language examples
(`app-cargo-go`, `app-cargo-rust`, `app-cargo-php`, `app-cargo-nodejs`,
`app-cargo-ruby`, `app-cargo-python`, `app-cargo-java`, `app-cargo-cpp`,
`app-cargo-csharp`) showing that any language runs on Acurast.

## How it works

- `acurast.json` declares `runtime: "Shell"` and an Ubuntu `proot-distro`
  image; `fileUrl` is the `app/` dir and `entrypoint` is `start.sh`.
- `start.sh` sets up `PATH`/`HOME`/DNS, installs `python3-requests` via
  `apt-get`, then runs the program with `python3`.
- `main.py` builds a JSON body (`language`, `runtime`, `message`) and POSTs it
  to `WEBHOOK_URL` (with a `/python` subpath for attribution) using `requests`.

## Setup

```bash
cp .env.example .env   # set ACURAST_MNEMONIC and WEBHOOK_URL
npm i
npm run deploy
```

## Notes

- Installs `requests` from apt (`python3-requests`) to avoid a `pip` step.
- `start.sh` also POSTs `status` reports to the webhook (`startup`, `done`, and
  `error` with the stage, exit code, and a stderr tail) so failures are visible
  — the processor's stdout/stderr isn't otherwise accessible. This is **not
  required**: the program already POSTs on success. To get a minimal example,
  remove the marked debug block, the `report`/`fail` calls, and the
  `apt-get install -y curl` line in `start.sh`.
