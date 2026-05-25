// types.ts — protocol-level types and pluggable interfaces

export type PeerId = string;

/**
 * The full state, wrapped with metadata needed for total ordering across split-brain scenarios.
 * `hash` is sha256 over a deterministic serialization of `payload`.
 */
export interface StateEnvelope<T = unknown> {
    epoch: number;
    generatedBy: PeerId;
    payload: T;
    hash: string;
}

/** Lightweight summary sent in PINGs so peers can detect divergence without shipping full payload. */
export interface EnvelopeSummary {
    epoch: number;
    generatedBy: PeerId;
    hash: string;
}

export type Payload<T = unknown> =
    | { type: 'ELECTION'; from: PeerId; epoch: number }
    | { type: 'OK'; from: PeerId; epoch: number }
    | { type: 'COORDINATOR'; from: PeerId; epoch: number }
    | { type: 'PING'; from: PeerId; epoch: number; isLeader: boolean; envelopeSummary: EnvelopeSummary | null }
    | { type: 'STATE_REQUEST'; from: PeerId }
    | { type: 'STATE_RESPONSE'; from: PeerId; envelope: StateEnvelope<T> | null };

export interface MessageHeader {
    type: 'request' | 'response'
    sender: PeerId
}

/**
 * Pluggable transport. Wire this up to TCP, libp2p, WebSockets, whatever.
 * `send` should not throw on transient delivery failure (peer offline is normal).
 */
export interface Transport<T = unknown> {
    send(to: PeerId, payload: Payload<T>): Promise<void>;
    reply(to: MessageHeader, payload: Payload<T>): Promise<void>;
    /** The bootstrap peer list (excluding or including self, doesn't matter — self is filtered). */
    peerIds(): PeerId[];
}

/** Pluggable persistence. In production: write atomically to disk (tmp + rename). */
export interface Persistence<T = unknown> {
    load(): Promise<StateEnvelope<T> | null>;
    save(envelope: StateEnvelope<T>): Promise<void>;
}

export interface PeerNodeOptions {
    /** Leader sends a PING this often. */
    pingIntervalMs?: number;            // default 500
    /** A follower triggers an election if no leader PING within this window. */
    leaderTimeoutMs?: number;           // default 2000
    /** Candidate's wait window for OK responses. Randomised per attempt to avoid herds. */
    electionTimeoutMinMs?: number;      // default 800
    electionTimeoutMaxMs?: number;      // default 1500
    /** New leader waits this long for state to surface from peers before generating. */
    stateAcquisitionMs?: number;        // default 1500
}

export type Role = 'follower' | 'candidate' | 'leader';

/** Total order on envelope summaries: higher epoch wins, ties broken by generatedBy. */
export function compareEnvelope(
    a: EnvelopeSummary | null,
    b: EnvelopeSummary | null,
): number {
    if (a === null && b === null) return 0;
    if (a === null) return -1;
    if (b === null) return 1;
    if (a.epoch !== b.epoch) return a.epoch - b.epoch;
    return a.generatedBy < b.generatedBy ? -1 : a.generatedBy > b.generatedBy ? 1 : 0;
}

export function summarize<T>(env: StateEnvelope<T> | null): EnvelopeSummary | null {
    if (env === null) return null;
    return { epoch: env.epoch, generatedBy: env.generatedBy, hash: env.hash };
}