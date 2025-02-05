# Acurast P2P Browser App

This is an example browser app designed to facilitate testing and showcasing communication with Acurast processors over a peer-to-peer network. The app leverages the libp2p framework to enable NAT traversal, peer connectivity, and message exchange.

## Development server

To start a local development server, run:

```bash
npm run start
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Building

To build the project run:

```bash
npm run build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Functionality Overview

The app provides the following functionalities:

#### Connecting to relay nodes

Relay nodes enable connectivity when peers are behind NAT or firewalls. To understand relay nodes better, see the [libp2p Circuit Relay docs](https://docs.libp2p.io/concepts/nat/circuit-relay/).

#### Transforming the processor's public key to a Peer ID

To transform the public key:

1. Input the Ed25519 public key of your deployment in hexadecimal format.
2. Click `Get Peer ID`

The app will compute and display the corresponding peer ID.

#### Connecting to a peer

To establish a connection with a peer:

1. Input the Multiaddr.
2. Click `Connect`.

If the peer is behind NAT or a firewall, you must use its circuit-relay address:

```
/<relay-multiaddr>/p2p-circuit/p2p/<peer-id>
```

For more information, see the [libp2p Circuit Relay Addresses docs](https://docs.libp2p.io/concepts/nat/circuit-relay/#relay-addresses).

#### Sending messages

Once a connection with a peer is established, you can send messages to it:

1. Select the message protocol.
2. Input the target Peer ID.
3. Type your message
4. Click `Send`.

The app will handle any responses.
