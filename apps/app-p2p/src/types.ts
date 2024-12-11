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
