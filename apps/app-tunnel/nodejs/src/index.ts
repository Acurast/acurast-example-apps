import { createServer, IncomingMessage, ServerResponse } from "http";
import { TunnelCoordinator } from "./coordinator";
import { P2P_RELAYS, requireNetworkConfig, requireDomainSuffix, LOCAL_ADDRESS, SECONDARY_LOCAL_ADDRESS, ACME_STAGING } from "./environment";
import { log } from "./utils";
import { reportError } from "./callback";

function startHttpServer(address: string, label: string, content?: () => string | undefined): Promise<void> {
    const [host, portStr] = address.split(":");
    const port = Number(portStr);
    if (!host || !Number.isFinite(port)) {
        throw Error(`Invalid address: ${address}`);
    }
    return new Promise((resolve, reject) => {
        const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
            const customContent = content ? content() : undefined
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`<h1>Hello from the ${label} connection:</h1><p>${customContent ?? 'Node.js'}</p>`);
        });
        server.once("error", reject);
        server.listen(port, host, () => {
            log(`HTTP server (${label}) listening on http://${host}:${port}`);
            resolve();
        });
    });
}

async function main() {
    const net = requireNetworkConfig();
    const coordinator = new TunnelCoordinator(net.rpcEndpoints, P2P_RELAYS, net.tunnelRelays, requireDomainSuffix(net.network), LOCAL_ADDRESS, SECONDARY_LOCAL_ADDRESS, ACME_STAGING);
    log("Starting coordinator");
    await coordinator.start();

    const tunnelInfo = () => {
        if (coordinator.tunnelInfo === undefined) {
            return undefined
        }
        return JSON.stringify(coordinator.tunnelInfo, undefined, 2)
    }

    log("Starting http servers");
    // Primary (ACME) connection forwards to LOCAL_ADDRESS; the secondary
    // (self-signed) connection forwards to SECONDARY_LOCAL_ADDRESS.
    await startHttpServer(LOCAL_ADDRESS, "primary", tunnelInfo);
    await startHttpServer(SECONDARY_LOCAL_ADDRESS, "secondary", tunnelInfo);
}

main().catch((error) => {
    log(`❌ Main: unhandled error: ${error}`, "error");
    void reportError(String(error?.stack ?? error));
});
