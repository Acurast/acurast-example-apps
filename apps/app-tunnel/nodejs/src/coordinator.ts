import { ApiPromise, WsProvider } from '@polkadot/api'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'

import { CoordinatorState, DeploymentId, DeploymentInfo, KeyPair, PeerInfo, TunnelInfo } from './types'
import { log, generateP256KeyPair, sleep, privateKeyHexToPkcs8Base64 } from './utils'
import { PeerNode, stableSerialize } from './leaderElection/peerNode'
import { MessageHeader, Payload, PeerId, Persistence, StateEnvelope, Transport } from './leaderElection/types'
import { reportStarted } from './callback'

declare const _STD_: any

export class TunnelCoordinator implements Transport<CoordinatorState>, Persistence<CoordinatorState> {

    private keyPair?: KeyPair
    private peerNode?: PeerNode<CoordinatorState>

    public tunnelInfo?: TunnelInfo

    public get deploymentInfo(): DeploymentInfo {
        let id: _DeploymentId = _STD_.job.getId()
        let slot: number = _STD_.job.getSlot()

        return {
            id: convertDeploymentId(id),
            slot
        }
    }

    public get peerInfo(): PeerInfo {
        const pubKeys: _PubKeys = _STD_.job.getPublicKeys()
        const encKeys: _PubEncKeys = _STD_.job.getEncryptionKeys()
        const slot: number = _STD_.job.getSlot()
        return {
            id: _STD_.p2p.peerIdFromPublicKey(pubKeys['ed25519']),
            p2pPubKey: pubKeys['ed25519'],
            encPubKey: encKeys['p256'],
            slot
        }
    }

    constructor(
        public readonly rpcs: string[], 
        public readonly p2pRelays: string[], 
        public readonly tunnelRelays: string[],
        public readonly domainSuffix: string,
        public readonly localAddress: string,
    ) {}

    private _peers?: PeerInfo[]
    public async peers(): Promise<PeerInfo[]> {
        if (this._peers !== undefined) {
            return this._peers
        }
        const api = await this.connect()
        const deploymentId = this.deploymentInfo.id
        const processors = (await api.query['acurastMarketplace']['assignedProcessors'].entries(deploymentId)).map(([key, _]) => {
            return key.args[1].toString()
        })
        const keys = processors.map((address) => [address, deploymentId])
        const peers: PeerInfo[] = (await api.query['acurastMarketplace']['storedMatches'].multi(keys)).map((value) => {
            const assignment = value.toPrimitive() as _Assignment
            if (!assignment.acknowledged) {
                return null
            }
            const p2pPubKey = assignment.pubKeys[2]!.ed25519
            const encPubKey = assignment.pubKeys[3] && 'secp256r1Encryption' in assignment.pubKeys[3]
                ? assignment.pubKeys[3].secp256r1Encryption
                : undefined
            return {
                id: _STD_.p2p.peerIdFromPublicKey(p2pPubKey),
                p2pPubKey,
                encPubKey,
                slot: assignment.slot
            }
        }).filter(isDefined).sort((a, b) => a.slot - b.slot)
        this._peers = peers
        return peers
    }

    public async start() {
        log('Fetching peers')
        let peers = await this.peers()
        log(`Fetched peers: ${JSON.stringify(peers, undefined, 2)}`)
        if (peers.length <= 0) {
            throw Error('No peers found')
        }
        if (peers.length === 1) {
            await this.runSolo()
            return
        }
        log('Starting P2P communication')
        await this.startP2PCommunication()
        log('Sleeping for 10 seconds')
        await sleep(10)
        log('Starting Peer Node')
        await this.startPeerNode()
    }

    private async runSolo(): Promise<void> {
        log('Solo deployment, skipping leader election ceremony')
        const persisted = await this.load()
        if (persisted !== null) {
            log('Restoring persisted state')
            this.keyPair = persisted.payload.keyPair
            await this.startTunnel(persisted.payload.certificate)
            return
        }
        const payload = await this.generateOwnState()
        const serialized = stableSerialize(payload)
        const hash = createHash('sha256').update(serialized).digest('hex')
        const envelope: StateEnvelope<CoordinatorState> = {
            epoch: 0,
            generatedBy: this.peerInfo.id,
            payload,
            hash,
        }
        await this.save(envelope)
    }

    private async generateOwnState(): Promise<CoordinatorState> {
        try {
            const keyPair = generateP256KeyPair()
            this.keyPair = keyPair
            await this.startTunnel()
            log('startTunnel returned, polling certPem')
            let pem: string | undefined | null = undefined
            let attempts = 12
            while (!isDefined(pem)) {
                log(`certPem attempt ${13 - attempts}`)
                pem = await _tunnelCertPem()
                log(`certPem -> ${typeof pem} ${pem ? `len=${pem.length}` : pem}`)
                if (isDefined(pem) || attempts <= 0) break
                attempts -= 1
                await sleep(10)
            }
            if (!isDefined(pem)) throw Error('PEM certificate not available')
            log('returning state')
            return { keyPair, certificate: pem }
        } catch (e: any) {
            log(`state gen threw: ${e?.stack || e}`, 'error')
            throw e
        }
    }

    private lastConnectIndex: number = 0
    private async connect(): Promise<ApiPromise> {
        let lastError: unknown | undefined = undefined;
        for (const [index, url] of rotate(this.rpcs, this.lastConnectIndex).entries()) {
            try {
                let api = await this._connect(url)
                this.lastConnectIndex = index
                return api
            } catch (error) {
                console.error(error)
                lastError = error
            }
        }
        throw lastError ?? Error('cannot connect to any rpc');
    }

    private apiCache = new Map<string, ApiPromise>()
    private connectPromises = new Map<string, Promise<ApiPromise>>()
    private async _connect(targetWsUrl: string): Promise<ApiPromise> {
        // Check cache first and validate the connection is actually active
        const cachedApi = this.apiCache.get(targetWsUrl)
        if (cachedApi !== undefined) {
            if (cachedApi.isConnected) {
                return cachedApi
            } else {
                // API is disconnected, clean up stale cache
                this.apiCache.delete(targetWsUrl)
                try {
                    await cachedApi.disconnect()
                } catch (error) {
                    console.debug('Error disconnecting stale API:', error)
                }
            }
        }

        // Check if there's already a connection in progress for this URL
        const existingPromise = this.connectPromises.get(targetWsUrl)
        if (existingPromise !== undefined) {
            return await existingPromise
        }

        // Create new connection
        const provider = new WsProvider(targetWsUrl)
        const connectPromise = ApiPromise.create({ provider })

        this.connectPromises.set(targetWsUrl, connectPromise)

        try {
            const api = await connectPromise

            // Cache the API instance
            this.apiCache.set(targetWsUrl, api)

            return api
        } finally {
            this.connectPromises.delete(targetWsUrl)
        }
    }

    private readonly P2P_PROTOCOL_MESSAGE_COORD = '/message/coord/1.0.0'
    private async startP2PCommunication(): Promise<void> {
        return new Promise((resolve, reject) => {
            _STD_.p2p.start(
                {
                    messageProtocols: [this.P2P_PROTOCOL_MESSAGE_COORD],
                    relays: this.p2pRelays,
                    idleConnectionTimeout: 300_000, // 5 minutes
                },
                () => {
                    log(`🛜🟢 P2P communication started`)
                    _STD_.p2p.onMessage((message: P2PMessage) => {
                        if (message.protocol === this.P2P_PROTOCOL_MESSAGE_COORD) {
                            this.onP2PMessage(message)
                        }
                    })
                    resolve()
                },
                (err: string) => {
                    log(`❌ P2P communication error: ${err}`, 'error')
                    reject(Error(err))
                }
            )
        })
    }

    private onP2PMessage(message: P2PMessage) {
        if (!isDefined(this.peerNode)) {
            return
        }
        if (!this.isKnownPeer(message.sender)) {
            log(`onCoordRequest: dropping message from unknown peer ${message.sender}`, 'warn')
            return
        }
        const payload: Payload<CoordinatorState> | null = deseralize(message.bytes)
        if (payload === null) {
            log(`onCoordRequest: dropping empty/invalid payload from ${message.sender}`, 'warn')
            return
        }
        this.peerNode.handleMessage(message, payload,)
    }

    private isKnownPeer(peer: PeerId): boolean {
        return this._peers?.find((value) => value.id === peer) !== undefined
    }

    private async startPeerNode() {
        this.peerNode = new PeerNode<CoordinatorState>(this.peerInfo.id, this, this, () => this.generateOwnState())
        this.peerNode.on('leader', () => {
            log(`  [${this.peerInfo.id}] became LEADER (epoch ${this.peerNode?.epoch})`)
        })
        this.peerNode.on('follower', (leader: PeerId) => {
            log(`  [${this.peerInfo.id}] following ${leader}`)
        })
        this.peerNode.on('state', async (state: StateEnvelope<CoordinatorState>) => {
            log(`  [${this.peerInfo.id}] state: epoch=${state.epoch} from=${state.generatedBy} hash=${state.hash.slice(0, 8)}`)
            if (this.peerNode?.currentRole !== 'follower') {
                return
            }
            this.keyPair = state.payload.keyPair
            const certificate = state.payload.certificate
            try {               
                await this.startTunnel(certificate)
            } catch (error) {
                log(`  [${this.peerInfo.id}] error: ${error}`, 'error')    
            }
        })
        this.peerNode.on('error', (error) => {
            log(`  [${this.peerInfo.id}] error: ${error}`, 'error')
        })
        await this.peerNode.start()
    }

    private async startTunnel(certificate?: string): Promise<TunnelInfo> {
        if (!isDefined(this.keyPair)) {
            throw Error('Identity not found')
        }
        await _tunnelStop()
        const spec: _TunnelSpec = {
            serverAddrs: this.tunnelRelays,
            domainSuffix: this.domainSuffix,
            localAddr: this.localAddress,
            primaryKey: {
                algorithm: 'Secp256r1',
                bytes: privateKeyHexToPkcs8Base64(this.keyPair.private)
            },
            certPem: certificate,
            acmeStaging: false,
        }

        const info: TunnelInfo = await _tunnelStart(spec)
        log(`Tunnel started: ${JSON.stringify(info, undefined, 2)}`)
        this.tunnelInfo = info
        await reportStarted(info)
        return info
    }

    private connectionMap: Record<PeerId, boolean> = {}
    private async connectToPeer(peerId: PeerId): Promise<boolean> {
        log(`⚡ Connecting to peer ${peerId}`)
        if (this.connectionMap[peerId]) {
            log(`🔌 Already connected to peer ${peerId}`)
            return true
        }

        const relayWithPeer = `${this.p2pRelays[0]}/p2p-circuit/p2p/${peerId}`
        return new Promise<boolean>((resolve) => {
            // Create a timeout ID that we can clear if connection succeeds
            const timeoutId = setTimeout(() => {
                log(`⏱️ Connection timeout for peer ${peerId}`, 'error')
                this.connectionMap[peerId] = false
                resolve(false)
            }, 20_000)

            _STD_.p2p.connect(
                relayWithPeer,
                {
                    timeout: 15_000, // 15s
                },
                () => {
                    // Clear the timeout since connection succeeded
                    clearTimeout(timeoutId)
                    log(`🔌 Successfully connected to peer ${peerId}`)
                    this.connectionMap[peerId] = true
                    resolve(true)
                },
                (errorMessage: string) => {
                    // Clear the timeout since we got a definitive error
                    clearTimeout(timeoutId)
                    log(
                        `❌ Failed to connect to peer ${peerId}: ${errorMessage}`,
                        'error'
                    )
                    this.connectionMap[peerId] = false
                    resolve(false)
                }
            )
        })
    }

    private async retryConnect(peerId: string): Promise<boolean> {
        this.connectionMap[peerId] = false
        const connected = await this.connectToPeer(peerId)
        return connected
    }

    private async _send(to: PeerId, protocol: string, message: string): Promise<void> {
        return new Promise((resolve, reject) => {
            _STD_.p2p.request(
                to,
                protocol,
                message,
                () => {
                    log(`📤 Request sent to ${to} successfully`)
                    resolve()
                },
                (errorMessage: string) => {
                    log(
                        `❌ Failed to send request to ${to}: ${errorMessage}`,
                        'error'
                    )
                    reject(Error(errorMessage))
                }
            )
        })
    }

    private async _reply(request: P2PMessage, message: string): Promise<void> {
        return new Promise((resolve, reject) => {
            _STD_.p2p.respond(
                request,
                message,
                () => {
                    log(`📤 Reply sent to ${request.sender} successfully`)
                    resolve()
                },
                (errorMessage: string) => {
                    log(
                        `❌ Failed to send reply to ${request.sender}: ${errorMessage}`,
                        'error'
                    )
                    reject(Error(errorMessage))
                }
            )
        })
    }

    public async send(to: PeerId, message: Payload<CoordinatorState>): Promise<void> {
        await this.connectToPeer(to)
        const hex = serialize(message)
        await this._send(to, this.P2P_PROTOCOL_MESSAGE_COORD, hex)
    }

    public async reply(request: P2PMessage, message: Payload<CoordinatorState>): Promise<void> {
        const hex = serialize(message)
        try {
            await this._reply(request, hex)
        } catch {
            if (await this.retryConnect(request.sender)) {
                await this._reply(request, hex)
            }
        }
    }

    public peerIds(): PeerId[] {
        return this._peers?.map((peer) => peer.id) ?? []
    }

    private readonly STATE_PATH = path.resolve(
        _STD_.job.storageDir,
        'state'
    )
    public async load(): Promise<StateEnvelope<CoordinatorState> | null> {
        log('Loading state')
        if (!fs.existsSync(this.STATE_PATH)) {
            log('State not present, returning null')
            return null
        }
        try {
            const data = fs.readFileSync(this.STATE_PATH, 'utf8')
            const decrypted = _STD_.signers.secp256r1.decrypt(this.peerInfo.encPubKey, this.peerInfo.encPubKey, data)
            const jsonStr = Buffer.from(decrypted, 'hex').toString('utf8')
            return JSON.parse(jsonStr)
        } catch (error) {
            log(
                `❌ Failed to decrypt state to store on file: ${error}`,
                'error'
            )
            throw error
        }
    }

    public async save(envelope: StateEnvelope<CoordinatorState>): Promise<void> {
        log('Saving state')
        const encoder = new TextEncoder()
        const data = Buffer.from(encoder.encode(JSON.stringify(envelope))).toString('hex')
        try {
            const encryptedKey: string = _STD_.signers.secp256r1.encrypt(
                this.peerInfo.encPubKey,
                this.peerInfo.encPubKey,
                data
            )
            fs.writeFileSync(this.STATE_PATH, encryptedKey, 'utf8')
            log(`💾 State stored in ${this.STATE_PATH}`)
            log(`📂 State exists ${fs.existsSync(this.STATE_PATH)}`)
        } catch (error) {
            log(
                `❌ Failed to encrypt state to store on file: ${error}`,
                'error'
            )
            throw error
        }
    }
}

type RecordWithOptional<All extends string, Optional extends All, V> =
    & Record<Exclude<All, Optional>, V>
    & Partial<Record<Optional, V>>

type _DeploymentId = { origin: { kind: string, source: string }, id: string }
type _PubKeyType = 'p256' | 'secp256k1' | 'ed25519' | 'secp256r1Encryption' | 'secp256k1Encryption'
interface P2PMessage extends MessageHeader {
    type: 'request' | 'response'
    id: string
    sender: string
    protocol: string
    bytes: string
}

type _PubKeys = RecordWithOptional<_PubKeyType, 'secp256k1Encryption' | 'secp256r1Encryption', string>
type _PubEncKeys = Partial<Omit<Record<_PubKeyType, string>, 'secp256r1Encryption' | 'secp256k1Encryption'>>
type _AssignmentSla = {
    total: number
    met: number
}
type _AssignmentPubKeyType = 'secp256r1' | 'secp256k1' | 'ed25519' | 'secp256r1Encryption' | 'secp256k1Encryption'
type _R1 = Pick<Record<_AssignmentPubKeyType, string>, 'secp256r1'>
type _K1 = Pick<Record<_AssignmentPubKeyType, string>, 'secp256k1'>
type _Ed = Pick<Record<_AssignmentPubKeyType, string>, 'ed25519'>
type _R1Enc = Pick<Record<_AssignmentPubKeyType, string>, 'secp256r1Encryption'>
type _K1Enc = Pick<Record<_AssignmentPubKeyType, string>, 'secp256k1Encryption'>
type _AssignmentPubKeys =
    | []
    | [_R1, _K1, _Ed]
    | [_R1, _K1, _Ed, _R1Enc]
    | [_R1, _K1, _Ed, _K1Enc]
    | [_R1, _K1, _Ed, _R1Enc, _K1Enc]
type _AssignmentExecutionType = 'all' | 'index'
type _AssignmentExecution =
    | Pick<Record<_AssignmentExecutionType, null>, 'all'>
    | Pick<Record<_AssignmentExecutionType, number>, 'index'>
type _Assignment = {
    slot: number
    startDelay: number
    feePerExecution: number
    acknowledged: boolean
    sla: _AssignmentSla
    pubKeys: _AssignmentPubKeys
    execution: _AssignmentExecution
}

type _TunnelSpec = {
    serverAddrs: string[]
    domainSuffix: string
    localAddr: string
    primaryKey: {
        algorithm: 'Secp256r1',
        bytes: string
    }
    acmeStaging?: boolean
    certPem?: string
}

function toLowerCamelCase(s: string): string {
    return s
        .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
        .replace(/^(.)/, c => c.toLowerCase())
}

function convertDeploymentId(id: _DeploymentId): DeploymentId {
    const raw = id['origin']['source']
    const source = raw.startsWith('0x') ? raw : `0x${raw}`
    return [
        { [toLowerCamelCase(id['origin']['kind'])]: source },
        Number(id['id'])
    ]
}

function rotate<T>(arr: T[], i: number): T[] {
    return [...arr.slice(i), ...arr.slice(0, i)]
}

function isDefined<T>(x: T): x is NonNullable<T> {
    return x != null // catches both null and undefined
}

function serialize<T>(message: T): string {
    const jsonStr = JSON.stringify(message)
    const bytes = Buffer.from(jsonStr, 'utf8')
    const hex = bytes.toString('hex')
    return hex
}

function deseralize<T>(message: string): T | null {
    if (!message || message.length === 0) {
        return null
    }
    const bytes = Buffer.from(message, 'hex')
    if (bytes.length === 0) {
        return null
    }
    const jsonStr = new TextDecoder().decode(bytes)
    if (jsonStr.trim().length === 0) {
        return null
    }
    try {
        return JSON.parse(jsonStr) as T
    } catch (e) {
        log(`deseralize: invalid JSON (len=${jsonStr.length}): ${e}`, 'error')
        return null
    }
}

const _tunnelStart = (spec: _TunnelSpec): Promise<TunnelInfo> => new Promise((res, rej) => _STD_.tunnel.start(spec, res, rej))
const _tunnelCertPem = (): Promise<string> => new Promise((res, rej) => _STD_.tunnel.certPem(res, rej));
const _tunnelStop = (): Promise<void> => new Promise((res, rej) => _STD_.tunnel.stop(res, rej));
// const _tunnelStatus = () => new Promise((res, rej) => _STD_.tunnel.status(res, rej));