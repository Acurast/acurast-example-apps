# Acurast Example App: Cargo SSH

This example shows how to open an interactive SSH session into an Acurast processor using the **Shell** runtime and a custom container image (Cargo deployment).

The deployment starts a [Dropbear](https://github.com/mkj/dropbear) SSH server inside the Ubuntu rootfs and exposes it via a reverse tunnel. The tunnel provider is selected via an environment variable, so the same deployment app works with ngrok, bore, or pinggy.

## How it works

- `acurast.json` declares `runtime: "Shell"` and an `image` URL pointing at an Ubuntu `proot-distro` tarball (with `sha256` for integrity).
- `fileUrl` is the local `app/` directory; the CLI uploads it to the processor.
- `entrypoint` is `start.sh`, which sets up the environment, starts Dropbear on port 2222, and delegates to the selected tunnel script.
- The tunnel script (`tunnel-ngrok.sh`, `tunnel-bore.sh`, or `tunnel-pinggy.sh`) opens a reverse TCP tunnel and sets `TUNNEL_HOST` and `TUNNEL_PORT`.
- Once the tunnel is up, the connect command is POSTed to `CALLBACK_URL`.

### getifaddrs override

Proot does not emulate network interfaces, so any binary that calls `getifaddrs` (such as ngrok) will fail. `getifaddrs_override.c` is compiled into a shared library at startup and injected via `LD_PRELOAD` for all SSH sessions, providing a minimal loopback-only implementation. See the [Acurast docs](https://docs.acurast.com/developers/build/cargo-runtime-environment#network-interfaces-getifaddrs) for more details.

## Tunnel providers

| Provider | `SSH_TUNNEL` value | Account required | Notes |
|---|---|---|---|
| [**ngrok**](https://ngrok.com) | `ngrok` | Yes (free) | Requires `NGROK_AUTHTOKEN` |
| [**bore**](https://github.com/ekzhang/bore) | `bore` | No | Uses `bore.pub`; may be unreachable from some networks |
| [**pinggy**](https://pinggy.io) | `pinggy` | No (optional) | Connects on port 443; set `PINGGY_ACCESS_TOKEN` for a stable URL |

> [!NOTE]
> The tunnel is established outbound from the device (port 443 for pinggy, custom port for bore/ngrok). The connecting client opens a TCP connection to the assigned address. Some networks block outbound TCP to non-standard ports — if `ssh` hangs and eventually times out, try from a different network or use a VPN.

## Setup

### Requirements

- An Acurast mnemonic with funds on the canary network.
- For ngrok: a free [ngrok](https://ngrok.com) account with an auth token.
- For pinggy: optionally a [pinggy.io](https://pinggy.io) access token.

> [!IMPORTANT]
> **ngrok:** TCP tunnels require a verified account. ngrok may ask you to add a credit card before allowing TCP tunnels on a free plan. To verify your setup works before deploying, run the following on your machine:
> ```bash
> ngrok config add-authtoken $NGROK_AUTHTOKEN && ngrok tcp 2222
> ```
> If a tunnel URL is printed, your account is configured correctly. If ngrok returns an error about TCP tunnels, follow the steps it provides to complete account verification.
>
> Read [ngrok's TCP tunnel documentation](https://ngrok.com/docs/universal-gateway/tcp) for more information.

### Configure

```bash
cp .env.example .env
```

Set:

- `ACURAST_MNEMONIC` — your funded mnemonic
- `SSH_TUNNEL` — tunnel provider: `ngrok`, `bore`, or `pinggy`
- `SSH_PASSWORD` — SSH root password (defaults to `password` if unset)
- `CALLBACK_URL` — endpoint that will receive tunnel status events (optional)
- `NGROK_AUTHTOKEN` — ngrok auth token (ngrok only)
- `PINGGY_ACCESS_TOKEN` — pinggy access token (pinggy only, optional)

Make sure all variables the deployment needs are listed in `includeEnvironmentVariables` in `acurast.json`, otherwise they will not be forwarded to the processor.

### Deploy

```bash
$ npm install -g @acurast/cli # install the Acurast CLI, if not already installed
$ acurast deploy
```

The CLI will upload the `app/` directory and submit the deployment described in `acurast.json`.

### Connect

Once the deployment is running, wait for the `started` event at your `CALLBACK_URL`:

```json
{
  "event": "started",
  "host": "<host>",
  "port": <port>
}
```

Then connect from your machine:

```bash
$ ssh root@<host> -p <port>
```

All Acurast environment variables are available in the session.

## Callback events

If `CALLBACK_URL` is set, the deployment POSTs JSON events to it throughout its lifecycle:

| Event | Payload | Description |
|---|---|---|
| `log` | `{"event":"log","message":"..."}` | Progress updates during setup |
| `started` | `{"event":"started","host":"...","port":...}` | Tunnel is ready |
| `error` | `{"event":"error","message":"..."}` | Something went wrong |

## Notes

- `execution.type` is `onetime` with a 1-hour `maxExecutionTimeInMs`. Adjust as needed.
- `onlyAttestedDevices: true` restricts execution to attested processors.
- The root password defaults to `password`. Do not use this deployment for anything sensitive without setting a strong `SSH_PASSWORD`.
