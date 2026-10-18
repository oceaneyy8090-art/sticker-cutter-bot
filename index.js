
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const FormData = require("form-data");
const sharp = require("sharp");

const TOKEN = process.env.BOT_TOKEN;
const REMOVE_BG_API_KEY = process.env.REMOVE_BG_API_KEY;

if (!TOKEN || !REMOVE_BG_API_KEY) {
  throw new Error("کلیدهای ربات تنظیم نشده‌اند.");
}

const bot = new TelegramBot(TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🌙 سلام! عکست رو بفرست تا پس‌زمینه‌ش حذف بشه و به شکل استیکر شفاف برگرده 🍓"
  );
});

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;

  try {
    await bot.sendMessage(chatId, "💫 دارم پس‌زمینه رو حذف می‌کنم...");

    const photos = msg.photo;
    const photo = photos[photos.length - 1];
    const fileLink = await bot.getFileLink(photo.file_id);

    const response = await axios.get(fileLink, {
      responseType: "arraybuffer",
      timeout: 60000
    });

    const form = new FormData();
    form.append("image_file", Buffer.from(response.data), {
      filename: "photo.png"
    });
    form.append("size", "auto");

    const result = await axios.post(
      "https://api.remove.bg/v1.0/removebg",
      form,
      {
        headers: {
          ...form.getHeaders(),
          "X-Api-Key": REMOVE_BG_API_KEY
        },
        responseType: "arraybuffer",
        timeout: 120000
      }
    );

    const sticker = await sharp(Buffer.from(result.data))
      .resize(512, 512, {
        fit: "inside",
        withoutEnlargement: false
      })
      .webp({ quality: 85, alphaQuality: 100 })
      .toBuffer();

    if (sticker.length > 512 * 1024) {
      throw new Error("Sticker file too large");
    }

    await bot.sendSticker(chatId, sticker, {
      reply_to_message_id: msg.message_id
    });
  } catch (error) {
    console.error(
      "Processing error:",
      error.response?.status || "",
      error.message
    );

    let message = "😿 نتونستم این عکس رو تبدیل کنم. یه عکس دیگه امتحان کن.";

    if (error.response?.status === 402) {
      message = "سهمیه یا اعتبار رایگان حذف پس‌زمینه تموم شده.";
    } else if (error.response?.status === 403) {
      message = "کلید حذف پس‌زمینه معتبر نیست یا اجازه استفاده نداره.";
    }

    await bot.sendMessage(chatId, message);
  }
});

bot.on("polling_error", (error) => {
  console.error("Telegram polling error:", error.message);
});

console.log("🌙 Sticker cutter bot is running!");
