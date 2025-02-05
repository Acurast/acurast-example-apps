import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Connection, Stream } from '@libp2p/interface';
import { enable, logger } from '@libp2p/logger';
import { ByteStream, byteStream } from 'it-byte-stream';
import {
  connect,
  createPeer,
  messageProtocols,
  openStream,
  Peer,
  peerIdFromHexPublicKey,
  RELAYS,
  sendMessage,
  streamProtocols,
  streamRead,
  streamWrite,
} from './p2p/libp2p';

const log = logger('browser');
enable('*');

enum Tab {
  MESSAGE = 'Message',
  STREAM = 'Stream',
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit {
  peer?: Peer;
  peerId?: string;

  connections: Map<string, Connection> = new Map();

  relays: Map<string, boolean> = new Map(
    RELAYS.map((relay) => {
      return [relay, false];
    }),
  );
  messageProtocols: string[] = messageProtocols;
  streamProtocols: string[] = streamProtocols;

  publicKeyToTransform?: string;
  peerIdFromPublicKey?: string;

  address?: string;
  connectedPeers: Map<string, boolean> = new Map();

  Tab: typeof Tab = Tab;
  tabs: Tab[] = Object.values(Tab);
  activeTab: Tab = this.tabs[0];

  messageProtocol: string = Array.from(this.messageProtocols.values())[0];
  messageReceiver?: string;
  messageRequest?: string;
  messageResponse?: string;

  streamProtocol: string = Array.from(this.streamProtocols.values())[0];
  streamReceiver?: string;
  stream?: ByteStream<Stream>;
  streamData?: string;
  streamRead?: string;

  async ngOnInit(): Promise<void> {
    this.peer = await createPeer();
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
      this.connections.delete(event.detail.toString());
    });
  }

  getPeerId(): void {
    if (this.publicKeyToTransform === undefined) {
      return;
    }

    this.peerIdFromPublicKey = peerIdFromHexPublicKey(
      this.publicKeyToTransform,
    ).toString();
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

  async connect(address: string | undefined): Promise<void> {
    if (this.peer === undefined || address === undefined) {
      return;
    }

    const conn = await connect(this.peer, address);
    this.connections.set(conn.remotePeer.toString(), conn);
  }

  selectTab(tab: Tab) {
    this.activeTab = tab;
  }

  setMessageProtocol(event: any) {
    this.messageProtocol = event.target.value;
  }

  async sendRequest(): Promise<void> {
    if (
      this.peer === undefined ||
      this.messageReceiver === undefined ||
      this.messageRequest === undefined
    ) {
      return;
    }

    this.messageResponse = await sendMessage(
      this.peer,
      this.messageProtocol,
      this.messageReceiver,
      this.messageRequest,
    );
    this.messageRequest = undefined;
  }

  setStreamProtocol(event: any) {
    this.streamProtocol = event.target.value;
  }

  async openStream(): Promise<void> {
    if (this.streamReceiver === undefined) {
      return;
    }

    const conn = this.connections.get(this.streamReceiver);
    if (conn === undefined) {
      return;
    }

    const stream = await openStream(conn, this.streamProtocol);

    this.stream = stream;
    this.streamRead = '';

    new Promise(async () => {
      const decoder = new TextDecoder();
      while (
        stream.unwrap().status === 'open' &&
        this.streamRead !== undefined
      ) {
        this.streamRead += await streamRead(stream);
      }
    });
  }

  async closeStream(): Promise<void> {
    this.stream?.unwrap().close();
    this.stream = undefined;
    this.streamData = undefined;
    this.streamRead = undefined;
  }

  async streamWrite(): Promise<void> {
    if (this.stream === undefined || this.streamData === undefined) {
      return;
    }

    await streamWrite(this.stream, this.streamData);
    this.streamData = undefined;
  }
}
