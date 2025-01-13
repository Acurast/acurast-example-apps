import {
  PROTOCOL_MESSAGE_ECHO,
  PROTOCOL_STREAM_ECHO,
  RELAYS,
} from "./constants";
import { Message, Stream } from "./types";

declare let _STD_: any;

function onRequest(request: Message) {
  switch (request.protocol) {
    case PROTOCOL_MESSAGE_ECHO:
      const text = Buffer.from(request.bytes, "hex").toString("utf-8");
      console.log("Received ECHO message request:", text);
      _STD_.p2p.respond(request, request.bytes);
      break;
    default:
      console.log("Unknown protocol:", request.protocol);
  }
}

async function onIncomingStream(stream: Stream) {
  switch (stream.protocol) {
    case PROTOCOL_STREAM_ECHO:
      let read = 0;
      while (true) {
        try {
          const bytes = await stream.read(16);

          read = bytes.length;
          if (read > 0) {
            console.log("Received ECHO stream request:", bytes.toString("hex"));
            await stream.write(bytes);
          } else {
            // stream is closed
            break;
          }
        } catch (err) {
          console.log("Error ECHO stream:", err);
        }
      }
      break;
    default:
      console.log("Unknown protocol:", stream.protocol);
  }
}

function main() {
  _STD_.p2p.start(
    {
      messageProtocols: [PROTOCOL_MESSAGE_ECHO],
      streamProtocols: [PROTOCOL_STREAM_ECHO],
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
      _STD_.p2p.onIncomingStream((stream: Stream) => {
        onIncomingStream(stream);
      });
    },
    (err: string) => {
      throw err;
    },
  );
}

main();
