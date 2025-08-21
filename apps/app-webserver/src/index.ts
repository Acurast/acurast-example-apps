import express from "express";
import localtunnel from "localtunnel";

/**
 * WARNING: This subdomain is NOT secure and should not be used in production.
 * Anyone can simply overwrite it with their own project and hijack requests
 * This is simply for testing purposes. If you need a secure way to host your
 * project, please reach out to us.
 */
const LOCALTUNNEL_SUBDOMAIN = ""; // This is the subdomain where your webserver will be available. Eg. https://example.proxy.acu.run

const LOCALTUNNEL_HOST = "https://proxy.acu.run/";
const LOCAL_PORT = 3000;

if (!LOCALTUNNEL_SUBDOMAIN) {
  console.log("LOCALTUNNEL_SUBDOMAIN must be set");
  process.exit(1);
}

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send(`<h1>Hello from Acurast!</h1>`);
});

app.listen(LOCAL_PORT, () =>
  console.log(`Server listening on port ${LOCAL_PORT}!`)
);

const startTunnel = async () => {
  const tunnel = await localtunnel({
    subdomain: LOCALTUNNEL_SUBDOMAIN,
    host: LOCALTUNNEL_HOST,
    port: LOCAL_PORT,
  });

  console.log("Tunnel started at", tunnel.url);
};

startTunnel();
