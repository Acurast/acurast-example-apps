import express from "express";
import localtunnel from "localtunnel";
import path from "path";

import { getDeploymentInfo } from "./get-deployment-info";
import { createTunnelWithRetry } from "./tunnel";
import { ADDRESS } from "./constants";
import { LOCAL_PORT } from "./constants";

const app = express();
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, "public")));

const startTime = Date.now();

app.get("/health", (req, res) => {
  res.json(true);
});

app.get("/info", (req, res) => {
  const deploymentInfo = getDeploymentInfo();

  const API_URL = "https://freeipapi.com/api/json";
  fetch(API_URL)
    .then((response) => response.json())
    .then((data) => {
      const report = {
        timestamp: Date.now(),
        acurast: deploymentInfo,
        data,
      };

      res.json(report);
    })
    .catch((error) => {
      console.error("Error fetching data:", error),
        res.json({
          timestamp: Date.now(),
          acurast: deploymentInfo,
          error: error.message,
        });
    });
});

app.listen(LOCAL_PORT, () =>
  console.log(`Server listening on port ${LOCAL_PORT}!`)
);

const main = async () => {
  try {
    const tunnel = await createTunnelWithRetry(ADDRESS, {
      port: LOCAL_PORT,
    });
    console.log("Server started at", tunnel.url);
    const tunnel2 = await createTunnelWithRetry(getDeploymentInfo().vanityUrl, {
      port: LOCAL_PORT,
    });
    console.log("Server started at", tunnel2.url);
  } catch (tunnelError) {
    console.error(
      "Failed to create tunnel, continuing with local server only",
      tunnelError
    );
  }
};

main();
