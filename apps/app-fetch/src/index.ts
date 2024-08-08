const WEBHOOK_URL = "REPLACE_ME"; // TODO: Replace with your https://webhook.site/ URL

const BASE_URL = "https://min-api.cryptocompare.com";
const SYMBOL = "BTC";
const TARGET_CURRENCY = "USD";

declare const _STD_: any;

if (typeof _STD_ === "undefined") {
  // If _STD_ is not defined, we know it's not running in the Acurast Cloud.
  // Define _STD_ here for local testing.
  console.log("Running in local environment");
  (global as any)._STD_ = {
    app_info: { version: "local" },
    job: { getId: () => "local" },
    device: { getAddress: () => "local" },
  };
}

fetch(`${BASE_URL}/data/price?fsym=${SYMBOL}&tsyms=${TARGET_CURRENCY}`)
  .then((response) => response.json())
  .then((data) => {
    const price = data[TARGET_CURRENCY];
    return fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        price,
        timestamp: Date.now(),
        acurast: {
          version: _STD_.app_info.version,
          deploymentId: _STD_.job.getId(),
          deviceAddress: _STD_.device.getAddress(),
        },
      }),
    })
      .then((postResponse) => console.log("Success:", postResponse.status))
      .catch((error) => console.error("Error posting data:", error));
  })
  .catch((error) => console.error("Error getting data:", error));
