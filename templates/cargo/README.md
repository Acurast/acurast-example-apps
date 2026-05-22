# Acurast Template: Cargo

A cargo-style Acurast deployment using the Shell runtime. Ships a directory of scripts/binaries to a processor and runs `start.sh` inside an Ubuntu image.

## Layout

```
examples/app/
  start.sh   # entrypoint
  hello.py   # sample program invoked by start.sh
```

`acurast.json` points `fileUrl` at `examples/app` — every file in that directory is uploaded as the cargo.

## Development

### Setup

Run `acurast init` to set up deployment credentials.

### Deploy

```bash
acurast deploy
```

The processor will download the image, mount the cargo, and execute `start.sh`.
