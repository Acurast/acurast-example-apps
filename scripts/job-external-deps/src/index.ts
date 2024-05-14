import BN from 'bn.js';
import crypto from 'node:crypto';

const API_ENDPOINT = '<YOUR_API_ENDPOINT>';

// generate a random 32-byte number
const n = new BN(crypto.randomBytes(32));

// send it to your backend
fetch(API_ENDPOINT, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ 
    result: n.toString(10)
  })
});
