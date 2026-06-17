// Uses the core http/https module rather than fetch/undici: fetch is
// unreliable under proot (broken getifaddrs / interface enumeration), while
// the core client works.
const http = require("http");
const https = require("https");
const { URL } = require("url");

const webhook = process.env.WEBHOOK_URL;
const body = JSON.stringify({
  language: "Node.js",
  runtime: process.version,
  message: "Hello from Node.js running on Acurast!",
});

const url = new URL(webhook);
const lib = url.protocol === "http:" ? http : https;

const req = lib.request(
  url,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  },
  (res) => {
    console.log("posted:", res.statusCode);
    res.resume();
  }
);

req.on("error", (err) => {
  console.error("POST failed:", err.message);
  process.exit(1);
});

req.write(body);
req.end();
