import localtunnel from "localtunnel";
import { PROXY_HOST } from "./constants";

export async function createTunnelWithRetry(
  subdomain: string,
  {
    port = 3000,
    retryDelay = 10000, // delay between retries in milliseconds
  } = {}
) {
  while (true) {
    try {
      const tunnel = await localtunnel({
        host: PROXY_HOST,
        port,
        subdomain,
      });

      // Check if we actually got the requested subdomain
      if ((tunnel as any).clientId === subdomain) {
        console.log(
          `Successfully set up tunnel on subdomain: https://${subdomain}.acu.run`
        );
        return tunnel;
      } else {
        const errorMsg = `Failed to claim subdomain. Got ${tunnel.url} instead of https://${subdomain}.acu.run`;
        console.log(errorMsg);
        // Close the tunnel, if any, before retrying
        tunnel.close();
      }
    } catch (err) {
      console.log(`Error creating tunnel:`, err);
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }
}
