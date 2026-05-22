export type Origin = 'acurast' | 'tezos' | 'ethereum' | 'alephZero' | 'vara' | 'ethereum20' | 'solana' | 'acurastCanary'
export type MultiOrigin = Partial<Record<Origin, string>>

export type DeploymentId = [MultiOrigin, number]
export type DeploymentInfo = {
    id: DeploymentId
    slot: number
}

export type PeerInfo = {
    id: string
    p2pPubKey: string
    encPubKey?: string
    slot: number
}

export type KeyPair = {
    public: string
    private: string
}

export type CoordinatorState = {
    keyPair: KeyPair
    certificate: string
}

export type TunnelInfo = {
    url: string
    clientId: string
    secondaryUrl: string
    secondaryClientId: string
}
