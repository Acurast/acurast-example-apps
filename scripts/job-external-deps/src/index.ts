import BN from 'bn.js';
import crypto from 'node:crypto';

// generate a random 32-byte number
const n = new BN(crypto.randomBytes(32));

// print it to the console
console.log("n =", n.toString(10));
