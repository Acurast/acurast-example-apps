# Acurast Example App: Cargo

This repository shows how to deploy a non-Node.js workload to Acurast using the **Shell** runtime and a custom container image (Cargo deployments).

The example installs `python3-requests` inside an Ubuntu rootfs at startup, calls the Acurast bridge socket to fetch the processor's `p256` public key, and posts it to a webhook.

## How it works

- `acurast.json` declares `runtime: "Shell"` and an `image` URL pointing at an Ubuntu `proot-distro` tarball (with `sha256` for integrity).
- `fileUrl` is the local `app/` directory; the CLI uploads it to the processor.
- `entrypoint` is `start.sh`, which sets up `PATH`/`HOME`, installs dependencies, and runs `hello.py`.
- `hello.py` opens the Unix bridge socket at `BRIDGE_SOCKET` and sends a `signer_publicKey` JSON-RPC request, then POSTs the result to `WEBHOOK_URL`.

## Setup

### Requirements

- An Acurast mnemonic with funds on the canary network.
- A webhook endpoint to receive the public key (e.g. [webhook.watch](https://webhook.watch)).

### Configure

Create a `.env` file:

```bash
cp .env.example .env
```

Set:

- `ACURAST_MNEMONIC` — your funded mnemonic
- `WEBHOOK_URL` — endpoint that will receive the POST

### Deploy

```bash
npm i
npm run deploy
```

The CLI will upload the `app/` directory and submit the deployment described in `acurast.json`.

## Notes

- The deployment runs every 3 minutes, 4 times, on three pinned processors (`assignmentStrategy.instantMatch`). Adjust as needed.
- `includeEnvironmentVariables: ["WEBHOOK_URL"]` makes the variable available to the script on the processor.
- `onlyAttestedDevices: true` restricts execution to attested processors.
