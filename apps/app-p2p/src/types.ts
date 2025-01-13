interface Peer {
  type: "address" | "peerId";
  value: string;
}

export interface Message {
  type: "request" | "response";
  id: string;
  sender: Peer;
  protocol: string;
  bytes: string;
}

export interface Stream {
  protocol: string;
  peer: Peer;
  read: (n: number) => Promise<Buffer>;
  write: (bytes: Uint8Array | string) => Promise<void>;
  close: () => Promise<void>;
}
