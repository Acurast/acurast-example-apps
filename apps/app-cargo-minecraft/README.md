# Acurast Example App: Minecraft (Cargo)

Runs a [Minecraft](https://www.minecraft.net) Java server inside an Acurast
Cargo deployment, exposed over the Acurast Tunnel's **two connections**:

- **Primary** connection (Let's Encrypt cert) → the Minecraft server port
  (`25565`) directly.
- **Secondary** connection (self-signed cert) →
  [Dropbear](https://github.com/mkj/dropbear) SSH server (`2222`).

Minecraft's wire protocol is raw TCP (not TLS), so the **easy way to play** is to
SSH in over the secondary connection and local-forward the game port (`ssh -L`):
the SSH session carries the raw TCP, no TLS wrapper needed on the client.

> Deploying this app **accepts the [Minecraft EULA](https://aka.ms/MinecraftEULA)**:
> `start.sh` writes `eula=true`.

## How it works

1. `start.sh` installs a JDK + `dropbear`, builds the `getifaddrs` shim (see
   [PRoot Quirks](https://docs.acurast.com/developers/build/cargo-runtime-environment#proot-quirks)),
   downloads the server jar, writes `eula=true` and a loopback-bound
   `server.properties`.
2. It starts the server on `127.0.0.1:25565`, sets the root password, and starts
   `dropbear` on `127.0.0.1:2222`.
3. `tunnel.py` calls `tunnel_start` with `localAddr=127.0.0.1:25565` (Minecraft)
   and `secondaryLocalAddr=127.0.0.1:2222` (SSH), then POSTs the SSH connect
   command to `CALLBACK_URL`.

## Connect

The `started` callback carries two commands: `connect` (interactive shell, for
debugging) and `forward` (local-forwards the game port to play). SSH is the
**secondary** connection — self-signed cert, port `443`.

To play, run `forward` (local-forwards `25565`):

```bash
ssh -N -L 25565:127.0.0.1:25565 \
  -o ProxyCommand='openssl s_client -quiet \
    -servername <secondaryClientId>.<DOMAIN_SUFFIX> \
    -connect <secondaryClientId>.<DOMAIN_SUFFIX>:443' \
  root@<secondaryClientId>
```

Leave it running, then in your Minecraft client add a server with address
`127.0.0.1:25565` and join.

To debug the deployment, run `connect` for a shell (no `-N`, no `-L`):

```bash
ssh -o ProxyCommand='openssl s_client -quiet \
    -servername <secondaryClientId>.<DOMAIN_SUFFIX> \
    -connect <secondaryClientId>.<DOMAIN_SUFFIX>:443' \
  root@<secondaryClientId>
```

> **Do not add `-N`** to the shell command — `-N` suppresses the remote shell, so
> the session only forwards ports and looks like it hangs after the password.

> **Direct (primary) connection:** the game port is also reachable on the primary
> (Let's Encrypt) connection at `<clientId>.<DOMAIN_SUFFIX>`, but the relay
> terminates TLS there — a vanilla client can't speak it. To use it you'd run a
> local TLS wrapper (e.g. `stunnel`) pointing at port `443` and connect the client
> to that local socket. The SSH local-forward above is simpler; use it unless you
> have a reason not to.

## Configure

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `ACURAST_MNEMONIC` | yes | Deployer seed phrase. **Do not commit.** |
| `SSH_PASSWORD` | no (default `password`) | Root password for the SSH session. **Set a strong value.** |
| `NETWORK` | yes | Target network: `canary` or `mainnet`. Selects the tunnel relays at runtime. Must match the `network` field in `acurast.json`. |
| `DOMAIN_SUFFIX_CANARY` / `DOMAIN_SUFFIX_MAINNET` | active one | Your tunnel DNS suffix (wildcard `*` + `_acu` TXT records published), one per network. Set only the one matching `NETWORK`. |
| `CALLBACK_URL` | no | Webhook for `log`/`started`/`error` events (carries the connect command). |
| `MC_SERVER_URL` | no | Override the server jar URL (vanilla/Paper/Fabric). Defaults to a pinned vanilla release. |

## Deploy

```bash
npm i
npm run deploy
```

## Notes

- The world lives in the processor's ephemeral storage and is **lost when the
  deployment ends**.
- Heap is `-Xmx1024M`; adjust in `start.sh` for the processor's RAM. `online-mode`
  is on (real accounts required) — set it to `false` in `server.properties` for
  cracked/offline testing.
- If `tunnel.py` logs "No secondary tunnel returned", the processor build predates
  `secondaryLocalAddr` support and the SSH play path won't be reachable.
- **Untested live** — the pinned jar URL and JVM memory are the likely hot spots;
  set `MC_SERVER_URL` if the default 404s, and watch the `error` callback.
