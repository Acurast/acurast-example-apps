import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { Identify, identify } from '@libp2p/identify';
import { enable, logger } from '@libp2p/logger';
import { peerIdFromString } from '@libp2p/peer-id';
import { ping, PingService } from '@libp2p/ping';
import { webSockets } from '@libp2p/websockets';
import * as filters from '@libp2p/websockets/filters';
import { multiaddr } from '@multiformats/multiaddr';
import { byteStream } from 'it-byte-stream';
import { createLibp2p, Libp2p } from 'libp2p';

const PROTOCOL_ECHO: string = '/echo/1';
const RELAYS: string[] = [
  '/ip4/34.65.182.19/tcp/30093/ws/p2p/12D3KooWKGfsBKUArB33AyHJksf9aWLvy4PD5NTbwp1gpc1GDa2k',
  '/ip4/34.65.238.238/tcp/30083/ws/p2p/12D3KooWSdrLcPjDBMyGfT5NehWaJvjSLEDKARuUS8eycQinRBzh',
];

const log = logger('browser');
enable('*');

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit {
  peer?: Libp2p<{
    dcutr: any;
    identify: Identify;
    ping: PingService;
    echo: {
      protocol: string;
    };
  }>;
  peerId?: string;

  relays: Map<string, boolean> = new Map(
    RELAYS.map((relay) => {
      return [relay, false];
    }),
  );
  protocols: string[] = [PROTOCOL_ECHO];

  address?: string;
  connectedPeers: Map<string, boolean> = new Map();

  protocol: string = Array.from(this.protocols.values())[0];
  receiver?: string;
  request?: string;
  response?: string;

  async ngOnInit(): Promise<void> {
    this.peer = await createLibp2p({
      addresses: {
        listen: ['/p2p-circuit'],
      },
      transports: [
        webSockets({ filter: filters.all }),
        circuitRelayTransport(),
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        dcutr: dcutr(),
        identify: identify(),
        ping: ping(),
        echo: () => ({
          protocol: PROTOCOL_ECHO,
        }),
      },
    });

    this.peerId = this.peer.peerId.toString();
    log('listening on %s', this.peer.getMultiaddrs());

    this.listen();
  }

  async listen(): Promise<void> {
    this.peer?.addEventListener('peer:connect', (event) => {
      this.setConnected(event.detail.toString(), true);
    });

    this.peer?.addEventListener('peer:disconnect', (event) => {
      this.setConnected(event.detail.toString(), false);
    });
  }

  setConnected(peerId: string, connected: boolean) {
    const relay = Array.from(this.relays.keys()).find((address) => {
      return address.endsWith(peerId.toString());
    });

    if (relay !== undefined) {
      this.relays.set(relay, connected);
    } else {
      this.connectedPeers.set(peerId, connected);
    }
  }

  async dial(address: string | undefined): Promise<void> {
    if (address === undefined) return;

    await this.peer?.dial(multiaddr(address));
  }

  setProtocol(event: any) {
    this.protocol = event.target.value;
  }

  async sendRequest(): Promise<void> {
    if (
      this.peer === undefined ||
      this.receiver === undefined ||
      this.request === undefined
    )
      return;

    const conn = await this.peer.dial(peerIdFromString(this.receiver));
    const signal = AbortSignal.timeout(15 * 60 * 1000);
    const stream = await conn.newStream(this.protocol, {
      signal,
      runOnLimitedConnection: true,
    });
    const buf = new TextEncoder().encode(this.request);
    const bytes = byteStream(stream);
    const [, output] = await Promise.all([
      bytes.write(buf, { signal }).then(() => stream.closeWrite()),
      bytes.read(buf.byteLength, { signal }),
    ]);
    await stream.close({ signal });

    this.response = new TextDecoder().decode(output.subarray());
  }
}
