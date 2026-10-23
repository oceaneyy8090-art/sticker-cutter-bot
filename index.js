
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const FormData = require("form-data");
const sharp = require("sharp");

const TOKEN = process.env.BOT_TOKEN;
const REMOVE_BG_API_KEY = process.env.REMOVE_BG_API_KEY;
const OWNER_ID = process.env.OWNER_ID;

const PACK_NAME = "mycute_stickers_by_StickerCutter80_bot";
const PACK_TITLE = "My Cute Stickers";

if (!TOKEN || !REMOVE_BG_API_KEY || !OWNER_ID) {
  throw new Error("BOT_TOKEN، REMOVE_BG_API_KEY یا OWNER_ID تنظیم نشده!");
}

const bot = new TelegramBot(TOKEN, { polling: true });
const api = `https://api.telegram.org/bot${TOKEN}`;

async function telegramRequest(method, form) {
  const response = await axios.post(
    `${api}/${method}`,
    form,
    {
      headers: form.getHeaders(),
      timeout: 120000,
      maxBodyLength: Infinity
    }
  );

  if (!response.data.ok) {
    throw new Error(response.data.description || "Telegram API error");
  }

  return response.data.result;
}

function stickerForm(buffer, method, extra = {}) {
  const form = new FormData();

  for (const [key, value] of Object.entries(extra)) {
    form.append(key, String(value));
  }

  const sticker = {
    sticker: "attach://stickerfile",
    format: "static",
    emoji_list: ["✨"]
  };

  form.append("stickerfile", buffer, {
    filename: "sticker.webp",
    contentType: "image/webp"
  });

  if (method === "createNewStickerSet") {
    form.append("stickers", JSON.stringify([sticker]));
  } else {
    form.append("sticker", JSON.stringify(sticker));
  }

  return form;
}

bot.onText(/\/start/, async (msg) => {
  if (String(msg.from.id) !== OWNER_ID) {
    return bot.sendMessage(msg.chat.id, "⛔ این ربات خصوصی است.");
  }

  bot.sendMessage(
    msg.chat.id,
    "🌙 سلام! عکست رو بفرست تا پس‌زمینه حذف بشه و استیکر به پک خودت اضافه بشه 🍓"
  );
});

bot.onText(/\/pack/, async (msg) => {
  if (String(msg.from.id) !== OWNER_ID) {
    return bot.sendMessage(msg.chat.id, "⛔ دسترسی نداری.");
  }

  bot.sendMessage(
    msg.chat.id,
    `🍓 لینک پک:\nhttps://t.me/addstickers/${PACK_NAME}`
  );
});

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;

  if (String(msg.from.id) !== OWNER_ID) {
    return bot.sendMessage(chatId, "⛔ این ربات خصوصی است.");
  }

  try {
    await bot.sendMessage(chatId, "💫 دارم استیکرت رو می‌سازم...");

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

    let packExists = false;

    try {
      const check = await axios.post(`${api}/getStickerSet`, {
        name: PACK_NAME
      });
      packExists = check.data.ok;
    } catch (error) {
      packExists = false;
    }

    if (packExists) {
      await telegramRequest(
        "addStickerToSet",
        stickerForm(sticker, "addStickerToSet", {
          user_id: OWNER_ID,
          name: PACK_NAME
        })
      );
    } else {
      await telegramRequest(
        "createNewStickerSet",
        stickerForm(sticker, "createNewStickerSet", {
          user_id: OWNER_ID,
          name: PACK_NAME,
          title: PACK_TITLE
        })
      );
    }

    await bot.sendMessage(
      chatId,
      `🍓 استیکر به پک اضافه شد!\nhttps://t.me/addstickers/${PACK_NAME}`
    );

  } catch (error) {
    console.error(
      "Processing error:",
      error.response?.data?.description || error.message
    );

    let message = "😿 مشکلی پیش اومد. دوباره امتحان کن.";

    if (error.response?.status === 402) {
      message = "سهمیه یا اعتبار Remove.bg تموم شده.";
    } else if (error.response?.status === 403) {
      message = "کلید Remove.bg معتبر نیست.";
    }

    await bot.sendMessage(chatId, message);
  }
});

bot.on("polling_error", (error) => {
  console.error("Telegram polling error:", error.message);
});

console.log("🌙 Sticker cutter bot is running!");
