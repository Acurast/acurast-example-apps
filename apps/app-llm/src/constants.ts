declare let _STD_: any;

if (typeof _STD_ === "undefined") {
  // If _STD_ is not defined, we know it's not running in the Acurast Cloud.
  // Define _STD_ here for local testing.
  console.log("Running in local environment");
  (global as any)._STD_ = {
    app_info: { version: "local" },
    job: { getId: () => "local", storageDir: "./" },
    device: { getAddress: () => "local" },
  };
}

export const MODEL_URL =
  "https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf";
export const MODEL_NAME = "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf";

export const STORAGE_DIR = _STD_.job.storageDir;

export const LOCALTUNNEL_HOST = "https://processor-proxy.sook.ch/";
