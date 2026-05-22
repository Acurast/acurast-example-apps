import { ec as EC } from 'elliptic'
import { createPrivateKey } from 'crypto'

import { KeyPair } from './types'

/**
 * Sleeps for a specified number of seconds
 * @param seconds Number of seconds to sleep
 * @returns Promise that resolves after the specified time
 */
export const sleep = (seconds: number) =>
    new Promise((resolve) => setTimeout(resolve, seconds * 1000))

/**
 * Logs a message to console with appropriate level and optionally reports errors to Sentry
 * @param message The message to log
 * @param type The log level ('default', 'warn', or 'error')
 */
export function log(
    message: any,
    type: 'default' | 'warn' | 'error' = 'default'
): void {
    switch (type) {
        case 'warn':
            console.warn(message)
            break
        case 'error':
            console.error(message)
            break
        default:
            console.log(message)
    }
}

/**
   * Generates a new P-256 (secp256r1) key pair for the manager
   * @returns Object containing private key hex, public key, and Tezos address (tz3)
   */
export function generateP256KeyPair(): KeyPair {
    // Initialize the P-256 curve
    const ec = new EC('p256')

    // Generate a key pair
    const keyPair = ec.genKeyPair()

    // Get private key in hex format
    const privateKeyHex = keyPair.getPrivate('hex').padStart(64, '0')

    // Get public key in compressed format
    const publicKeyHex = keyPair.getPublic(true, 'hex')

    return {
        public: publicKeyHex,
        private: privateKeyHex,
    }
}

export function privateKeyHexToPkcs8Base64(privateKeyHex: string): string {
    const ec = new EC('p256');
    const keyPair = ec.keyFromPrivate(privateKeyHex.padStart(64, '0'), 'hex');
    const pub = keyPair.getPublic();

    const hexToB64Url = (hex: string) =>
        Buffer.from(hex.padStart(64, '0'), 'hex').toString('base64url');

    const jwk = {
        kty: 'EC',
        crv: 'P-256',
        d: hexToB64Url(privateKeyHex),
        x: hexToB64Url(pub.getX().toString(16)),
        y: hexToB64Url(pub.getY().toString(16)),
    };

    const key = createPrivateKey({ key: jwk, format: 'jwk' });
    return key.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}