const WEBHOOK_URL = "WEBHOOK_URL"; // TODO: Replace with your https://webhook.site/ URL

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

fetch(WEBHOOK_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    timestamp: Date.now(),
    acurast: {
      version: _STD_.app_info.version,
      deploymentId: _STD_.job.getId(),
      deviceAddress: _STD_.device.getAddress(),
      env: _STD_.env["MY_SECRET_ENV_VAR"], // Send the env var to the server. Normally you would not do this and keep the env var secret. This is just for demo purposes.
    },
  }),
})
  .then((postResponse) => console.log("Success:", postResponse.status))
  .catch((error) => console.error("Error posting data:", error));
