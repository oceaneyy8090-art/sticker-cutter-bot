
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const FormData = require("form-data");
const sharp = require("sharp");

const TOKEN = process.env.BOT_TOKEN;
const REMOVE_BG_API_KEY = process.env.REMOVE_BG_API_KEY;

if (!TOKEN || !REMOVE_BG_API_KEY) {
  throw new Error(
    "BOT_TOKEN یا REMOVE_BG_API_KEY تنظیم نشده!"
  );
}

const bot = new TelegramBot(TOKEN, { polling: true });
const api = `https://api.telegram.org/bot${TOKEN}`;

const PACK_TITLE = "Cute Stickers";
const processing = new Set();
const userPacks = new Map();

function makePackName(userId) {
  return `cutie_by_${userId}_bot`;
}

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
    throw new Error(
      response.data.description || "Telegram API error"
    );
  }

  return response.data.result;
}

function createStickerForm(buffer, method, extra = {}) {
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

bot.onText(/^\/start(?:@\w+)?(?:\s|$)/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    "🌙 سلام به استیکرساز کوچولو!\n\n" +
    "🍓 یه عکس بفرست تا پس‌زمینه‌ش حذف بشه.\n" +
    "💫 استیکرت رو دریافت کن و به پک خودت اضافه کن!\n\n" +
    "برای دریافت لینک پک خودت /pack رو بزن."
  );
});

bot.onText(/^\/pack(?:@\w+)?(?:\s|$)/, async (msg) => {
  const packName = userPacks.get(msg.from.id);

  if (!packName) {
    return bot.sendMessage(
      msg.chat.id,
      "🍓 هنوز پکی نساختی! اول یه عکس بفرست."
    );
  }

  await bot.sendMessage(
    msg.chat.id,
    `🌙 لینک پک استیکرهات:\nhttps://t.me/addstickers/${packName}`
  );
});

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (processing.has(userId)) {
    return bot.sendMessage(
      chatId,
      "⏳ یه کوچولو صبر کن؛ هنوز دارم عکس قبلیت رو آماده می‌کنم!"
    );
  }

  processing.add(userId);

  try {
    await bot.sendMessage(
      chatId,
      "💫 دارم پس‌زمینهٔ عکست رو حذف می‌کنم..."
    );

    const photos = msg.photo;
    const photo = photos[photos.length - 1];
    const fileLink = await bot.getFileLink(photo.file_id);

    const imageResponse = await axios.get(fileLink, {
      responseType: "arraybuffer",
      timeout: 60000
    });

    const form = new FormData();

    form.append(
      "image_file",
      Buffer.from(imageResponse.data),
      { filename: "photo.png" }
    );

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
        withoutEnlargement: true
      })
      .webp({
        quality: 85,
        alphaQuality: 100
      })
      .toBuffer();

    if (sticker.length > 512 * 1024) {
      throw new Error("Sticker file too large");
    }

    // Send the sticker directly to the user.
    await bot.sendSticker(chatId, sticker, {
      reply_to_message_id: msg.message_id
    });

    // Every Telegram user gets their own sticker pack.
    const packName = makePackName(userId);
    let packExists = false;

    try {
      const check = await axios.post(
        `${api}/getStickerSet`,
        { name: packName },
        { timeout: 30000 }
      );

      packExists = check.data.ok;
    } catch {
      packExists = false;
    }

    if (packExists) {
      await telegramRequest(
        "addStickerToSet",
        createStickerForm(sticker, "addStickerToSet", {
          user_id: userId,
          name: packName
        })
      );
    } else {
      await telegramRequest(
        "createNewStickerSet",
        createStickerForm(sticker, "createNewStickerSet", {
          user_id: userId,
          name: packName,
          title: PACK_TITLE
        })
      );
    }

    userPacks.set(userId, packName);

    await bot.sendMessage(
      chatId,
      "🍓 استیکرت ساخته شد و به پک اختصاصی‌ات اضافه شد!\n\n" +
      `🌙 https://t.me/addstickers/${packName}`
    );

  } catch (error) {
    console.error(
      "Processing error:",
      error.response?.data?.description || error.message
    );

    let message = "😿 مشکلی پیش اومد. دوباره امتحان کن.";

    if (error.response?.status === 402) {
      message = "🍓 اعتبار Remove.bg تموم شده.";
    } else if (error.response?.status === 403) {
      message = "🔑 کلید Remove.bg معتبر نیست.";
    } else if (
      error.response?.data?.description?.includes("STICKERSET")
    ) {
      message =
        "🌙 ساخت پک استیکر مشکل داشت؛ استیکر ارسال‌شده رو داری، دوباره امتحان کن.";
    }

    try {
      await bot.sendMessage(chatId, message);
    } catch (sendError) {
      console.error("Send error:", sendError.message);
    }
  } finally {
    processing.delete(userId);
  }
});

bot.on("polling_error", (error) => {
  console.error("Telegram polling error:", error.message);
});

console.log("🌙 Sticker Cutter Bot is running!");
