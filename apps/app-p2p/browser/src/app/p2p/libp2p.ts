import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { keys } from '@libp2p/crypto';
import { dcutr } from '@libp2p/dcutr';
import { Identify, identify } from '@libp2p/identify';
import { Connection, PeerId, Stream } from '@libp2p/interface';
import { peerIdFromPublicKey, peerIdFromString } from '@libp2p/peer-id';
import { ping, PingService } from '@libp2p/ping';
import { webSockets } from '@libp2p/websockets';
import * as filters from '@libp2p/websockets/filters';
import { multiaddr } from '@multiformats/multiaddr';
import { ByteStream, byteStream } from 'it-byte-stream';
import { createLibp2p, Libp2p } from 'libp2p';

const PROTOCOL_MESSAGE_ECHO: string = '/message/echo/1.0.0';
export const messageProtocols: string[] = [PROTOCOL_MESSAGE_ECHO];

const PROTOCOL_STREAM_ECHO: string = '/stream/echo/1.0.0';
export const streamProtocols: string[] = [PROTOCOL_STREAM_ECHO];

export const RELAYS: string[] = [
  '/ip4/34.65.182.19/tcp/30093/ws/p2p/12D3KooWKGfsBKUArB33AyHJksf9aWLvy4PD5NTbwp1gpc1GDa2k',
  '/ip4/34.65.160.177/tcp/30083/ws/p2p/12D3KooWSdrLcPjDBMyGfT5NehWaJvjSLEDKARuUS8eycQinRBzh',
];

const timeout: AbortSignal = AbortSignal.timeout(15 * 60 * 1000); // 15m

const textDecoder: TextDecoder = new TextDecoder();
const textEncoder: TextEncoder = new TextEncoder();

export type Peer = Libp2p<{
  dcutr: any;
  identify: Identify;
  ping: PingService;
  messageEcho: {
    protocol: string;
  };
  streamEcho: {
    protocol: string;
  };
}>;

export async function createPeer(): Promise<Peer> {
  return await createLibp2p({
    addresses: {
      listen: ['/p2p-circuit'],
    },
    transports: [webSockets({ filter: filters.all }), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      dcutr: dcutr(),
      identify: identify(),
      ping: ping(),
      messageEcho: () => ({
        protocol: PROTOCOL_MESSAGE_ECHO,
      }),
      streamEcho: () => ({
        protocol: PROTOCOL_STREAM_ECHO,
      }),
    },
  });
}

export function peerIdFromHexPublicKey(publicKey: string): PeerId {
  return peerIdFromPublicKey(
    keys.publicKeyFromRaw(Buffer.from(publicKey, 'hex')),
  );
}

export async function connect(
  peer: Peer,
  address: string,
): Promise<Connection> {
  return await peer.dial(multiaddr(address));
}

export async function sendMessage(
  peer: Peer,
  protocol: string,
  receiver: string,
  request: string,
): Promise<string> {
  const conn = await peer.dial(peerIdFromString(receiver));
  const stream = await conn.newStream(protocol, {
    signal: timeout,
    runOnLimitedConnection: true,
  });
  const buf = new TextEncoder().encode(request);
  const bytes = byteStream(stream);
  const [, output] = await Promise.all([
    bytes.write(buf, { signal: timeout }).then(() => stream.closeWrite()),
    bytes.read(buf.byteLength, { signal: timeout }),
  ]);
  await stream.close({ signal: timeout });

  return textDecoder.decode(output.subarray());
}

export async function openStream(
  conn: Connection,
  protocol: string,
): Promise<ByteStream<Stream>> {
  return byteStream(
    await conn.newStream(protocol, {
      signal: timeout,
      runOnLimitedConnection: true,
    }),
  );
}

export async function closeStream(stream: ByteStream<Stream>): Promise<void> {
  stream.unwrap().close();
}

export async function streamWrite(
  stream: ByteStream<Stream>,
  data: string,
): Promise<void> {
  const buf = textEncoder.encode(data);
  await stream.write(buf, { signal: timeout });
}

export async function streamRead(stream: ByteStream<Stream>): Promise<string> {
  const buf = await stream.read(1, { signal: timeout });
  return textDecoder.decode(buf.subarray());
}
