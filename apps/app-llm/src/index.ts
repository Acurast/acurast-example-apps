import path from "path";
import {
  MODEL_URL,
  MODEL_NAME,
  STORAGE_DIR,
  LOCALTUNNEL_HOST,
} from "./constants";
import { createWriteStream, existsSync } from "fs";
import { Readable } from "stream";
import { finished } from "stream/promises";
import localtunnel from "localtunnel";

declare let _STD_: any;

const MODEL_FILE = path.resolve(STORAGE_DIR, MODEL_NAME);
async function downloadModel(url: string, destination: string) {
  console.log("Downloading model", MODEL_NAME);
  const res = await fetch(url);

  if (!res.body) {
    throw new Error("No response body");
  }

  console.log("Writing model to file:", destination);
  const writer = createWriteStream(destination);
  await finished(Readable.fromWeb(res.body as any).pipe(writer));
}
async function main() {
  if (!existsSync(MODEL_FILE)) {
    await downloadModel(MODEL_URL, MODEL_FILE);
  } else {
    console.log("Using already downloaded model:", MODEL_FILE);
  }
  console.log("Model downloaded, starting server...");

  _STD_.llama.server.start(
    ["--model", MODEL_FILE, "--ctx-size", "2048", "--threads", "8"],
    () => {
      // onCompletion
      console.log("Llama server closed.");
    },
    (error: any) => {
      // onError
      console.log("Llama server error:", error);
      throw error;
    }
  );
  const tunnel = await localtunnel({
    port: 8080,
    host: LOCALTUNNEL_HOST,
    subdomain: _STD_.device.getAddress().toLowerCase(),
  });

  console.log("Server started at", tunnel.url);
}

main();

// To prompt the model, you can use the following code:

/*

export const promptModel = async (prompt: string) => {
  console.log("FETCH");
  const response = await fetch(`${DEPLOYMENT_URL}/completion`, {
    method: "POST",
    body: JSON.stringify({
      prompt,
      n_predict: 300,
    }),
  });
  const json = await response.json();
  console.log(JSON.stringify(json));

  return JSON.stringify(json);
};

*/
