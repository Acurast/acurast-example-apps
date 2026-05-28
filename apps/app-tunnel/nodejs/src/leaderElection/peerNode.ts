// peer-node.ts — Bully election + leader-driven state acquisition + bidirectional state gossip

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import {
    PeerId, StateEnvelope, EnvelopeSummary, Payload, Transport, Persistence,
    PeerNodeOptions, Role, compareEnvelope, summarize,
    MessageHeader,
} from './types';
import { log } from '../utils';

const DEFAULTS_MULTIPLIER: number = 10

const DEFAULTS: Required<PeerNodeOptions> = {
    pingIntervalMs: 500 * DEFAULTS_MULTIPLIER,
    leaderTimeoutMs: 2000 * DEFAULTS_MULTIPLIER,
    electionTimeoutMinMs: 800 * DEFAULTS_MULTIPLIER,
    electionTimeoutMaxMs: 1500 * DEFAULTS_MULTIPLIER,
    stateAcquisitionMs: 1500 * DEFAULTS_MULTIPLIER,
};

/**
 * A peer node implementing leader election and one-shot state distribution.
 *
 *   Events:
 *     'leader'            — this node just became leader
 *     'follower' (leader) — this node became follower of `leader`
 *     'state' (envelope)  — current state envelope changed (initial, adopted, or generated)
 *     'error' (err)       — transport or generation failure
 */
export class PeerNode<T = unknown> extends EventEmitter {
    private role: Role = 'follower';
    private currentEpoch = 0;
    private leaderId: PeerId | null = null;
    private envelope: StateEnvelope<T> | null = null;

    private pingTimer?: ReturnType<typeof setInterval>;
    private leaderDeadline?: ReturnType<typeof setTimeout>;
    private electionTimer?: ReturnType<typeof setTimeout>;
    private acquisitionTimer?: ReturnType<typeof setTimeout>;

    private readonly opts: Required<PeerNodeOptions>;
    private started = false;

    constructor(
        public readonly myId: PeerId,
        private readonly transport: Transport<T>,
        private readonly persistence: Persistence<T>,
        private readonly generateState: () => Promise<T>,
        options: PeerNodeOptions = {},
    ) {
        super();
        this.opts = { ...DEFAULTS, ...options };
    }

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        // Restore any persisted envelope from a previous run.
        this.envelope = await this.persistence.load();
        if (this.envelope) {
            this.emit('state', this.envelope);
            this.currentEpoch = Math.max(this.currentEpoch, this.envelope.epoch);
        }
        this.enterFollower(null);
    }

    stop(): void {
        if (!this.started) return;
        this.started = false;
        this.clearAllTimers();
    }

    get state(): StateEnvelope<T> | null { return this.envelope; }
    get currentRole(): Role { return this.role; }
    get currentLeader(): PeerId | null { return this.leaderId; }
    get epoch(): number { return this.currentEpoch; }

    // ===== Role transitions =====

    private enterFollower(leaderId: PeerId | null): void {
        const wasNotFollower = this.role !== 'follower';
        this.role = 'follower';
        this.leaderId = leaderId;

        this.clearTimer('pingTimer');
        this.clearTimer('electionTimer');
        this.clearTimer('acquisitionTimer');
        this.resetLeaderDeadline();

        if (leaderId !== null && (wasNotFollower || this.leaderId !== leaderId)) {
            this.emit('follower', leaderId);
        }
    }

    private enterCandidate(): void {
        this.role = 'candidate';
        this.leaderId = null;
        this.currentEpoch += 1;

        this.clearTimer('leaderDeadline');
        this.clearTimer('pingTimer');
        this.clearTimer('acquisitionTimer');

        const higherPeers = this.peerIdsExcludingSelf().filter(id => id > this.myId);
        if (higherPeers.length === 0) {
            // Highest ID in the configured set — uncontested win.
            this.enterLeader();
            return;
        }

        for (const peer of higherPeers) {
            this.sendQuiet(peer, { type: 'ELECTION', from: this.myId, epoch: this.currentEpoch });
        }

        const timeout = randomBetween(this.opts.electionTimeoutMinMs, this.opts.electionTimeoutMaxMs);
        this.electionTimer = setTimeout(() => {
            if (this.role === 'candidate') this.enterLeader();
        }, timeout);
    }

    private enterLeader(): void {
        this.role = 'leader';
        this.leaderId = this.myId;

        this.clearTimer('electionTimer');
        this.clearTimer('leaderDeadline');

        // Announce.
        for (const peer of this.peerIdsExcludingSelf()) {
            this.sendQuiet(peer, { type: 'COORDINATOR', from: this.myId, epoch: this.currentEpoch });
        }

        // Begin pinging. First ping immediately so followers see us fast.
        this.sendPing();
        this.pingTimer = setInterval(() => this.sendPing(), this.opts.pingIntervalMs);

        // Begin state acquisition window. During this window, our PINGs will trigger any peer
        // with higher state to push it to us (see `reconcileState`).
        this.acquisitionTimer = setTimeout(() => {
            this.finishStateAcquisition().catch(err => this.emit('error', err));
        }, this.opts.stateAcquisitionMs);

        this.emit('leader');
    }

    private async finishStateAcquisition(): Promise<void> {
        if (this.role !== 'leader') return; // stepped down meanwhile

        if (this.envelope !== null) {
            // Either we had persisted state, or a follower's response gave us state during the window.
            return;
        }

        // Nobody has any state. Generate it now.
        const payload = await this.generateState();
        const serialized = stableSerialize(payload);
        const hash = createHash('sha256').update(serialized).digest('hex');
        const envelope: StateEnvelope<T> = {
            epoch: this.currentEpoch,
            generatedBy: this.myId,
            payload,
            hash,
        };
        await this.persistence.save(envelope);
        this.envelope = envelope;
        this.emit('state', envelope);
    }

    // ===== Message handling =====

    public async handleMessage(header: MessageHeader, payload: Payload<T>): Promise<void> {
        if (!this.started) return;
        switch (payload.type) {
            case 'ELECTION': return this.onElection(header, payload.epoch);
            case 'OK': return this.onOk(header.sender, payload.epoch);
            case 'COORDINATOR': return this.onCoordinator(header.sender, payload.epoch);
            case 'PING': return this.onPing(header, payload.epoch, payload.isLeader, payload.envelopeSummary);
            case 'STATE_REQUEST': return this.onStateRequest(header);
            case 'STATE_RESPONSE': return this.onStateResponse(header.sender, payload.envelope);
        }
    }

    private onElection(header: MessageHeader, epoch: number): void {
        const from = header.sender
        // Always acknowledge to let the sender know someone's home.
        this.sendQuiet(header, { type: 'OK', from: this.myId, epoch: this.currentEpoch });

        if (epoch > this.currentEpoch) this.currentEpoch = epoch;

        // If they have lower ID, we outrank them — start our own election.
        if (from < this.myId && this.role !== 'candidate') {
            this.enterCandidate();
        }
    }

    private onOk(from: PeerId, epoch: number): void {
        if (this.role === 'candidate' && epoch >= this.currentEpoch && from > this.myId) {
            // A higher peer is alive. Stand down and wait for them to announce.
            this.clearTimer('electionTimer');
            this.enterFollower(null);
        }
    }

    private onCoordinator(from: PeerId, epoch: number): void {
        if (epoch < this.currentEpoch) return; // stale
        this.currentEpoch = epoch;

        if (this.role === 'leader' && from !== this.myId) {
            // Concurrent leader (split brain). Higher ID wins.
            if (from > this.myId) this.enterFollower(from);
            return;
        }
        this.enterFollower(from);
    }

    private onPing(header: MessageHeader, epoch: number, isLeader: boolean, summary: EnvelopeSummary | null): void {
        const from = header.sender
        if (epoch > this.currentEpoch) {
            this.currentEpoch = epoch;
            if (this.role !== 'follower') this.enterFollower(isLeader ? from : null);
        }

        if (isLeader && epoch >= this.currentEpoch) {
            if (this.role === 'leader' && from !== this.myId) {
                // Split brain: another leader at our epoch. Higher ID wins.
                if (from > this.myId) this.enterFollower(from);
            } else if (this.role === 'follower') {
                if (this.leaderId !== from) this.emit('follower', from);
                this.leaderId = from;
                this.resetLeaderDeadline();
            } else if (this.role === 'candidate') {
                this.enterFollower(from);
            }
        }

        this.reconcileState(header, summary);
    }

    private reconcileState(header: MessageHeader, theirSummary: EnvelopeSummary | null): void {
        const mySummary = summarize(this.envelope);
        const cmp = compareEnvelope(theirSummary, mySummary);

        if (cmp > 0) {
            // They have strictly higher: pull it.
            this.sendQuiet(header, { type: 'STATE_REQUEST', from: this.myId });
        } else if (cmp < 0 && this.envelope !== null) {
            // We have strictly higher: push it unsolicited.
            this.sendQuiet(header, { type: 'STATE_RESPONSE', from: this.myId, envelope: this.envelope });
        }
    }

    private onStateRequest(header: MessageHeader): void {
        this.sendQuiet(header, { type: 'STATE_RESPONSE', from: this.myId, envelope: this.envelope });
    }

    private async onStateResponse(from: PeerId, envelope: StateEnvelope<T> | null): Promise<void> {
        if (envelope === null) return;

        // Verify hash before adopting anything from the wire.
        const computedHash = createHash('sha256').update(stableSerialize(envelope.payload)).digest('hex');
        if (computedHash !== envelope.hash) {
            this.emit('error', new Error(`Hash mismatch on state from ${from}; rejecting`));
            return;
        }

        if (compareEnvelope(summarize(envelope), summarize(this.envelope)) <= 0) {
            return; // we already have something at least as good
        }

        await this.persistence.save(envelope);
        this.envelope = envelope;
        console.log(`[peerNode] onStateResponse: emitting state from=${from} hash=${envelope.hash.slice(0,8)}`)
        this.emit('state', envelope);
    }

    // ===== Helpers =====

    private sendPing(): void {
        const msg: Payload<T> = {
            type: 'PING',
            from: this.myId,
            epoch: this.currentEpoch,
            isLeader: this.role === 'leader',
            envelopeSummary: summarize(this.envelope),
        };
        for (const peer of this.peerIdsExcludingSelf()) this.sendQuiet(peer, msg);
    }

    private sendQuiet(to: MessageHeader | PeerId, payload: Payload<T>): void {
        if (typeof to === 'string') {
            this.transport.send(to, payload).catch((reason) => {
                log(`❌ P2P communication error: ${reason}`, 'error')
            })
        } else {
            switch (to.type) {
                case 'request':
                    this.transport.reply(to, payload).catch((reason) => {
                        log(`❌ P2P communication error: ${reason}`, 'error')
                    });
                    break
                case 'response':
                    this.transport.send(to.sender, payload).catch((reason) => {
                        log(`❌ P2P communication error: ${reason}`, 'error')
                    })      
                    break
            }
        }
    }

    private peerIdsExcludingSelf(): PeerId[] {
        return this.transport.peerIds().filter(id => id !== this.myId);
    }

    private resetLeaderDeadline(): void {
        this.clearTimer('leaderDeadline');
        // Add jitter so peers don't all elect simultaneously on a fresh cluster.
        const timeout = this.opts.leaderTimeoutMs + Math.floor(Math.random() * 500);
        this.leaderDeadline = setTimeout(() => {
            if (this.role === 'follower' && this.started) this.enterCandidate();
        }, timeout);
    }

    private clearTimer(name: 'pingTimer' | 'leaderDeadline' | 'electionTimer' | 'acquisitionTimer'): void {
        const t = this[name];
        if (t === undefined) return;
        if (name === 'pingTimer') clearInterval(t as ReturnType<typeof setInterval>);
        else clearTimeout(t as ReturnType<typeof setTimeout>);
        this[name] = undefined;
    }

    private clearAllTimers(): void {
        this.clearTimer('pingTimer');
        this.clearTimer('leaderDeadline');
        this.clearTimer('electionTimer');
        this.clearTimer('acquisitionTimer');
    }
}

function randomBetween(min: number, max: number): number {
    return Math.floor(min + Math.random() * (max - min));
}

/** Deterministic JSON for hashing: sorts object keys. */
export function stableSerialize(x: unknown): string {
    return JSON.stringify(x, (_key, value) => {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            const sorted: Record<string, unknown> = {};
            for (const k of Object.keys(value).sort()) sorted[k] = (value as Record<string, unknown>)[k];
            return sorted;
        }
        return value;
    });
}