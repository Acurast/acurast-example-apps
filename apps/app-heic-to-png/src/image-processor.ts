import { existsSync, mkdirSync, writeFile } from "fs";
import { promisify } from "util";
const convert = require("heic-convert");

export const processImage = async (identifier: string, inputBuffer: Buffer) => {
  const images = await convert.all({
    buffer: inputBuffer,
    format: "PNG",
  });

  // Create output directory if it doesn't exist
  const outputDir = `./results/${identifier}`;
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  for (let idx in images) {
    const image = images[idx];
    const outputBuffer = await image.convert();
    await promisify(writeFile)(`${outputDir}/${idx}.png`, outputBuffer);
  }

  // Return only the first image
  return {
    success: true,
    url: `${outputDir}/0.png`,
  };
};
