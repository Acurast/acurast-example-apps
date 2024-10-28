import localtunnel from "localtunnel";
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { processImage } from "./image-processor";
import { promisify } from "util";
import { html } from "./html";

const LOCAL_PORT = 3000;
const LOCALTUNNEL_HOST = "https://processor-proxy.sook.ch/";
const LOCALTUNNEL_SUBDOMAIN = "heic-to-png";

const app = express();

app.use(express.json());

declare let _STD_: any;
if (typeof _STD_ === "undefined") {
  // If _STD_ is not defined, we know it's not running in the Acurast Cloud.
  // Define _STD_ here for local testing.
  console.log("Running in local environment");
  (global as any)._STD_ = {
    job: { getId: () => "local", storageDir: path.join(__dirname, "..") },
  };
}

const STORAGE_DIR_PATH = path.join(_STD_.job.storageDir, "uploads");

// Create uploads directory if it doesn't exist
const uploadDir = STORAGE_DIR_PATH;
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const upload = multer({ storage: storage });

app.get("/", (req, res) => {
  res.send(html);
});

// TODO: Persist the image urls
const processedImages = new Map<string, string>();

app.post("/upload", upload.single("image"), async (req, res) => {
  console.log("HEIC FILE UPLOADED");
  if (!req.file) {
    res.status(400).json({ success: false, error: "No file uploaded." });
    return;
  }

  const isHeicFile = req.file.originalname.toLowerCase().endsWith(".heic");
  if (!isHeicFile) {
    // Delete the uploaded non-HEIC file
    fs.unlinkSync(req.file.path);
    res
      .status(400)
      .json({ success: false, error: "Please upload a HEIC file." });
    return;
  }

  const id = Math.random().toString(36).substring(2, 15);

  res.json({ success: true, id });

  // Here we could upload the file to a remote storage and save its url
  const inputBuffer = await promisify(fs.readFile)(req.file.path);
  const result = await processImage(id, inputBuffer);
  processedImages.set(id, result.url);
});

app.get("/processed/:id", (req, res) => {
  if (!req.params.id) {
    res.status(400).json({ success: false, error: "No id provided." });
    return;
  }

  const filename = processedImages.get(req.params.id);
  if (!filename) {
    res.status(404).json({ success: false, error: "Image not processed yet." });
    return;
  }

  const downloadUrl = `/download/${req.params.id}.png`;
  res.json({ success: true, url: downloadUrl });
});

app.get("/download/:id.png", (req, res) => {
  const filePath = processedImages.get(req.params.id);
  if (!filePath) {
    res.status(404).json({ success: false, error: "Image not found" });
    return;
  }
  const fileStream = fs.createReadStream(filePath);
  fileStream.pipe(res);
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

  console.log(`Tunnel started at ${tunnel.url}`);
};

startTunnel();
