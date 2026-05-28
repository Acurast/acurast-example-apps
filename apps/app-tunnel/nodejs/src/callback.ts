import https from 'https'
import http from 'http'

import { log } from './utils'
import { TunnelInfo } from './types'

declare const _STD_: any

function callbackUrl(): string | undefined {
    const url = _STD_?.env?.['CALLBACK_URL']
    return typeof url === 'string' && url.length > 0 ? url : undefined
}

function httpPostJson(targetUrl: string, body: string): Promise<void> {
    return new Promise((resolve, reject) => {
        let parsed: URL
        try {
            parsed = new URL(targetUrl)
        } catch (e) {
            reject(e)
            return
        }
        const isHttps = parsed.protocol === 'https:'
        const client = isHttps ? https : http
        const req = client.request(
            {
                method: 'POST',
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: `${parsed.pathname}${parsed.search}`,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                const status = res.statusCode ?? 0
                res.on('data', () => { /* drain */ })
                res.on('end', () => {
                    if (status >= 200 && status < 300) {
                        resolve()
                    } else {
                        reject(Error(`HTTP ${status}`))
                    }
                })
            }
        )
        req.on('error', reject)
        req.write(body)
        req.end()
    })
}

async function postCallback(payload: object): Promise<void> {
    const url = callbackUrl()
    log(`Callback URL: ${url}`)
    if (url === undefined) return
    try {
        await httpPostJson(url, JSON.stringify(payload))
    } catch (e) {
        log(`callback POST failed: ${e}`, 'warn')
    }
}

export function reportStarted(info: TunnelInfo): Promise<void> {
    return postCallback({ event: 'started', data: info })
}

export function reportError(message: string): Promise<void> {
    return postCallback({ event: 'error', data: message })
}
