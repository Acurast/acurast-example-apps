declare const _STD_: any

// Network-specific values. The set is picked from $NETWORK (see .env). Keep the
// `network` field in acurast.json in sync with this — the CLI does not read $NETWORK.
type NetworkConfig = { tunnelRelays: string[]; rpcEndpoints: string[] }
const NETWORKS: Record<string, NetworkConfig> = {
    canary: {
        tunnelRelays: [
            'relay-2.canary.acurast.com:4433',
            'canary-relay.5elementsnodes.com:4433',
            'relay.el9-acurast.com:4433',
            'canary-relay.vincent-acurast.xyz:4433',
            'canary-relay.acurast.online:4433',
        ],
        rpcEndpoints: ['wss://public-rpc.canary.acurast.com'],
    },
    mainnet: {
        tunnelRelays: ['relay-1.mainnet.acurast.com:4433'],
        rpcEndpoints: ['wss://public-rpc.mainnet.acurast.com'],
    },
}

export function requireNetworkConfig(): NetworkConfig & { network: string } {
    const network = _STD_?.env?.['NETWORK']
    const cfg = typeof network === 'string' ? NETWORKS[network] : undefined
    if (cfg === undefined) {
        throw Error(`NETWORK env var must be one of ${Object.keys(NETWORKS).join(', ')}; got ${network}`)
    }
    return { ...cfg, network }
}

// DNS suffix you control (wildcard `*` + `_acu` TXT records published). One name
// per network — DOMAIN_SUFFIX_CANARY / DOMAIN_SUFFIX_MAINNET — but only the one
// matching $NETWORK needs to be set (and forwarded via includeEnvironmentVariables).
// The tunnel cannot work without it.
export function requireDomainSuffix(network: string): string {
    const key = `DOMAIN_SUFFIX_${network.toUpperCase()}`
    const value = _STD_?.env?.[key]
    if (typeof value !== 'string' || value.length === 0) {
        throw Error(`${key} env var not set; cannot start tunnel without a domain suffix`)
    }
    return value
}
// Primary (ACME) connection forwards here.
export const LOCAL_ADDRESS = '127.0.0.1:8080'
// Secondary (self-signed) connection forwards here. The processor opens the
// secondary connection automatically; we only choose which local port it targets.
export const SECONDARY_LOCAL_ADDRESS = '127.0.0.1:8081'
// Issue staging Let's Encrypt certificates. Set to false for production deployments.
export const ACME_STAGING = true

export const P2P_RELAYS = [
    '/dns4/relayer-1.p2p.acurast.com/tcp/9001/p2p/12D3KooWD2AdgRQEtBEouYxuqNedG3zNqRqNJCo6KeFbHsxrrW8P',
    '/dns4/relayer-2.p2p.acurast.com/tcp/9001/p2p/12D3KooWLiQg755461ybdiaZCfdHaXuDFnUoFsvUBLAHhP8yxg5v',
    '/dns4/relayer-3.p2p.acurast.com/tcp/9001/p2p/12D3KooWEQNxFMQpQgQBKWDrpzh9ydpdGGJNcvzvXL7A3ozJA6L1',
    '/dns4/relayer-4.p2p.acurast.com/tcp/9001/p2p/12D3KooWM1UCWAtGpg3aWf3X8zi2GqKrWpBdDqdxUKJvHdCbvkdT',
    '/dns4/relayer-5.p2p.acurast.com/tcp/9001/p2p/12D3KooWFrk28rVpvsfemUSDnHdtmfDD7XsJYTszEgx6s8JJt8wg',
]