import { PROTOCOL_ECHO, RELAYS } from "./constants";
import { Message } from "./types";

declare let _STD_: any;

function onRequest(request: Message) {
  switch (request.protocol) {
    case PROTOCOL_ECHO:
      const text = Buffer.from(request.bytes, "hex").toString("utf-8");
      console.log("Received ECHO request:", text);
      _STD_.p2p.respond(request, request.bytes);
      break;
    default:
      console.log("Unknown protocol:", request.protocol);
  }
}

function main() {
  _STD_.p2p.start(
    {
      messageProtocols: [PROTOCOL_ECHO],
      relays: [...RELAYS],
      idleConnectionTimeout: 300_000, // 5 min
    },
    () => {
      _STD_.p2p.onMessage((message: Message) => {
        switch (message.type) {
          case "request":
            onRequest(message);
            break;
          case "response":
            console.log(
              "Unexpected response:",
              JSON.stringify(message, null, 2),
            );
            break;
        }
      });
    },
    (err: string) => {
      throw err;
    },
  );
}

main();
