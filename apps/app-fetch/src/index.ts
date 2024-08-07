// We do this so the typescript compiler doesn't complain about the missing package
const device = eval("require")("@acurast-job/device");

declare const _STD_: any;

// A webhook URL to send the sum to
// For testing, you can go to https://webhook.site/ to create your own webhook for testing
const WEBHOOK_URL = "https://webhook.site/ff06a603-e955-4f65-a87f-3d08d8c17b07";

const API_URL = "https://min-api.cryptocompare.com";
const TARGET_CURRENCY = "USD";
const SYMBOL = "BTC";

console.log(`${API_URL}/data/price?fsym=${SYMBOL}&tsyms=${TARGET_CURRENCY}`);
fetch(`${API_URL}/data/price?fsym=${SYMBOL}&tsyms=${TARGET_CURRENCY}`)
  .then((response) => response.json())
  .then((data) => {
    // console.log("Success1:", data);

    const price = data[TARGET_CURRENCY];

    console.log("Price: ", price);

    // Send the sum to a webhook
    fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        price,
        timestamp: Date.now(),
        acurast: {
          version: _STD_.app_info.version,
          deviceAddress: device.getAddress(),
        },
      }),
    })
      .then((data) => console.log("Success:", data.status, data.statusText))
      .catch((error) => console.error("Error2:", error));
  })
  .catch((error) => console.error("Error1:", error));
