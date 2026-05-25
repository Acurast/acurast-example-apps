import { createServer, IncomingMessage, ServerResponse } from "http";
import { TunnelCoordinator } from "./coordinator";
import { P2P_RELAYS, TUNNEL_RELAYS, RPC_ENDPOINTS, DOMAIN_SUFFIX, LOCAL_ADDRESS } from "./environment";
import { log } from "./utils";

function startHttpServer(address: string, content?: () => string | undefined): Promise<void> {
    const [host, portStr] = address.split(":");
    const port = Number(portStr);
    if (!host || !Number.isFinite(port)) {
        throw Error(`Invalid LOCAL_ADDRESS: ${address}`);
    }
    return new Promise((resolve, reject) => {
        const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
            const customContent = content ? content() : undefined
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`<h1>Hello from: ${customContent ?? 'Node.js'}</h1>`);
        });
        server.once("error", reject);
        server.listen(port, host, () => {
            log(`HTTP server listening on http://${host}:${port}`);
            resolve();
        });
    });
}

async function main() {
    const coordinator = new TunnelCoordinator(RPC_ENDPOINTS, P2P_RELAYS, TUNNEL_RELAYS, DOMAIN_SUFFIX, LOCAL_ADDRESS);
    log("Starting coordinator");
    await coordinator.start();

    log("Starting http server");
    await startHttpServer(LOCAL_ADDRESS, () => {
        if (coordinator.tunnelInfo === undefined) {
            return undefined
        }
        return JSON.stringify(coordinator.tunnelInfo, undefined, 2)
    });
}

main().catch((error) => log(`❌ Main: unhandled error: ${error}`, "error"));
