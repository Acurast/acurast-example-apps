import TelegramBot from "node-telegram-bot-api";
import { getCryptoPrice, tryParseCode } from "./util";

// WARNING: DO NOT DO THIS IN PRODUCTION
// This is only for demonstration purposes.
// This will bundle the entire config.json file into the final build, including the bot token.
// In production, you should use environment variables.
import config from "../config.json";

const TELEGRAM_BOT_TOKEN = config.TELEGRAM_BOT_TOKEN;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: true,
});

bot.on("message", async (msg) => {
  if (!msg.text) return;

  const chatId = msg.chat.id;

  if (msg.text.startsWith("/start")) {
    bot.sendMessage(
      msg.chat.id,
      "Welcome! This is an example Telegram bot running on the Acurast Network!\n\nSend me a cryptocurrency symbol (e.g., btc) to get the current price."
    );
    return;
  }

  if (msg.text.startsWith("/code")) {
    tryParseCode(bot, msg);
    return;
  }

  const symbol = msg.text.toLowerCase().trim();
  const price = await getCryptoPrice(symbol);

  bot.sendMessage(chatId, price);
});

console.log("Bot is running...");
