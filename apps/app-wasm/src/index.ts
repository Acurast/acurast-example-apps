import wasmUrl from "./add.wasm";

interface WasmModule {
  add: (first: number, second: number) => number;
}

// A webhook URL to send the sum to
// For testing, you can go to https://webhook.site/#!/view/a758e8c5-71ca-4ee4-9f5c-1b2d4abb51dc/4dd0ef06-e0bd-4de0-b7e3-4f3f8f5d0817 or create your own
const WEBHOOK_URL = "https://webhook.site/a758e8c5-71ca-4ee4-9f5c-1b2d4abb51dc";

WebAssembly.instantiateStreaming(fetch(wasmUrl)).then((wasmModule) => {
  const { add } = wasmModule.instance.exports as unknown as WasmModule;

  // Sum up 2 numbers by using
  const sum = add(5, 6);

  console.log("Result", sum);

  // Send the sum to a webhook
  fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sum }),
  })
    // .then((response) => response.json())
    .then((data) => console.log("Success:", data.status, data.statusText))
    .catch((error) => console.error("Error:", error));
});
