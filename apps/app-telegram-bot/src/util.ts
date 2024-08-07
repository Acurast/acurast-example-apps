import axios from "axios";
import TelegramBot from "node-telegram-bot-api";

const API_URL = "https://min-api.cryptocompare.com";
const TARGET_CURRENCY = "USD";

export const getCryptoPrice = async (symbol: string) => {
  console.log(`Fetching price for ${symbol}...`);
  try {
    const response = await axios.get(
      `${API_URL}/data/price?fsym=${symbol}&tsyms=${TARGET_CURRENCY}`
    );
    const price = response.data?.[TARGET_CURRENCY];

    return price ? `$${price}` : `Invalid cryptocurrency symbol "${symbol}".`;
  } catch (error) {
    console.error("Error fetching crypto price:", error);
    return "Error fetching crypto price.";
  }
};

export const tryParseCode = (bot: TelegramBot, msg: TelegramBot.Message) => {
  if (!msg.text) return;

  try {
    console.log("Code: ", msg.text);

    const args = msg.text.split(" ");
    const code = args.slice(1).join(" ");
    const result = eval("(function() {" + code + "}())");

    bot.sendMessage(msg.chat.id, `<pre>${code}</pre>` + "\n\n" + result, {
      parse_mode: "HTML",
    });
  } catch (e) {
    console.log(e);
    bot.sendMessage(msg.chat.id, "Error while executing code: " + e);
  }
};
