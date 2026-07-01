# Acurast Example App: Java (cargo / Shell runtime)

> 📖 **Docs / full walkthrough:** [Run Any Language on Acurast (Java)](https://docs.acurast.com/developers/examples/languages#java)

Runs a minimal **Java** program in the Acurast **Shell** runtime (a Cargo
deployment): an Ubuntu `proot-distro` rootfs where a JDK is installed at
startup, then the program is compiled and run and POSTs a small JSON payload to
your `WEBHOOK_URL`. One of a set of single-language examples
(`app-cargo-go`, `app-cargo-rust`, `app-cargo-php`, `app-cargo-nodejs`,
`app-cargo-ruby`, `app-cargo-python`, `app-cargo-java`, `app-cargo-cpp`,
`app-cargo-csharp`) showing that any language runs on Acurast.

## How it works

- `acurast.json` declares `runtime: "Shell"` and an Ubuntu `proot-distro`
  image; `fileUrl` is the `app/` dir and `entrypoint` is `start.sh`.
- `start.sh` sets up `PATH`/`HOME`/DNS, installs `default-jdk` via `apt-get`,
  then runs the program with `java Main.java` (single-file source launch).
- `Main.java` builds a JSON body (`language`, `runtime`, `message`) and POSTs
  it to `WEBHOOK_URL` (with a `/java` subpath for attribution) using
  `java.net.http.HttpClient`.

## Setup

```bash
cp .env.example .env   # set ACURAST_MNEMONIC and WEBHOOK_URL
npm i
npm run deploy
```

## Notes

- Uses single-file source-code launch (`java Main.java`, JDK 11+) — no separate
  `javac` step — and the built-in `java.net.http.HttpClient`.
- `start.sh` also POSTs `status` reports to the webhook (`startup`, `done`, and
  `error` with the stage, exit code, and a stderr tail) so failures are visible
  — the processor's stdout/stderr isn't otherwise accessible. This is **not
  required**: the program already POSTs on success. To get a minimal example,
  remove the marked debug block, the `report`/`fail` calls, and the
  `apt-get install -y curl` line in `start.sh`.
