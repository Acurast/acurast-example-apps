import crypto from "crypto";

// https://github.com/andreasonny83/unique-names-generator/tree/main/src/dictionaries

import adjectives from "./adjectives";
import colors from "./colors";
import animals from "./animals";

export function getDeterministicUrl(address: string, number: string): string {
  // Step 1: Concatenate and hash
  const input = `${address}-${number}`;
  const hash = crypto.createHash("sha256").update(input).digest("hex");

  // Step 2: Convert hash to a big integer
  const bigIntHash = BigInt("0x" + hash);

  // Step 3: Split hash into four parts
  const adjIndex1 = Number(bigIntHash % BigInt(adjectives.length));
  const adjIndex2 = Number(
    (bigIntHash / BigInt(adjectives.length)) % BigInt(adjectives.length)
  );
  const colorIndex = Number(
    (bigIntHash / BigInt(adjectives.length * adjectives.length)) %
      BigInt(colors.length)
  );
  const animalIndex = Number(
    (bigIntHash /
      BigInt(adjectives.length * adjectives.length * colors.length)) %
      BigInt(animals.length)
  );

  // Step 4: Map to words
  const adjective1 = adjectives[adjIndex1];
  const adjective2 = adjectives[adjIndex2];
  const color = colors[colorIndex];
  const animal = animals[animalIndex];

  return `${adjective1}-${adjective2}-${color}-${animal}`;
}
