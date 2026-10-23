
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const FormData = require("form-data");
const sharp = require("sharp");

const TOKEN = process.env.BOT_TOKEN;
const REMOVE_BG_KEY = process.env.REMOVE_BG_API_KEY;

if (!TOKEN || !REMOVE_BG_KEY) {
  throw new Error(
    "Missing BOT_TOKEN or REMOVE_BG_API_KEY in GitHub Secrets"
  );
}

const bot = new TelegramBot(TOKEN, { polling: true });
const processedImages = new Map();
let botUsername = "";

const mainMenu = {
  inline_keyboard: [
    [{ text: "✂️ حذف پس‌زمینه عکس", callback_data: "help" }],
    [{ text: "📦 ساخت پک استیکر", callback_data: "pack" }],
    [{ text: "✨ راهنمای استفاده", callback_data: "guide" }]
  ]
};

function photoMenu() {
  return {
    inline_keyboard: [
      [{ text: "📦 ساخت پک / افزودن استیکر", callback_data: "pack" }],
      [{ text: "🔄 پردازش عکس جدید", callback_data: "again" }],
      [{ text: "🏠 منوی اصلی", callback_data: "menu" }]
    ]
  };
}

async function sendMenu(chatId) {
  await bot.sendMessage(
    chatId,
    "🌙 به ربات استیکرساز خوش اومدی!\n\n" +
      "عکس رو بفرست تا پس‌زمینه‌ش حذف بشه.",
    { reply_markup: mainMenu }
  );
}

async function getPhotoBuffer(fileId) {
  const file = await bot.getFile(fileId);

  if (!file.file_path) {
    throw new Error("TELEGRAM_FILE_PATH_MISSING");
  }

  const url =
    `https://api.telegram.org/file/bot${TOKEN}/` +
    file.file_path;

  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 60000,
    maxContentLength: 20 * 1024 * 1024
  });

  return Buffer.from(response.data);
}

async function removeBackground(imageBuffer) {
  const form = new FormData();

  form.append("image_file", imageBuffer, {
    filename: "photo.jpg",
    contentType: "image/jpeg"
  });

  form.append("size", "auto");
  form.append("format", "png");

  const response = await axios.post(
    "https://api.remove.bg/v1.0/removebg",
    form,
    {
      headers: {
        ...form.getHeaders(),
        "X-Api-Key": REMOVE_BG_KEY
      },
      responseType: "arraybuffer",
      timeout: 120000,
      maxContentLength: 25 * 1024 * 1024,
      maxBodyLength: 25 * 1024 * 1024
    }
  );

  return Buffer.from(response.data);
}

async function makeSticker(imageBuffer) {
  let output = await sharp(imageBuffer)
    .rotate()
    .resize(512, 512, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png({
      palette: true,
      quality: 80,
      effort: 10
    })
    .toBuffer();

  if (output.length > 512 * 1024) {
    output = await sharp(imageBuffer)
      .rotate()
      .resize(512, 512, { fit: "inside" })
      .png({ compressionLevel: 9, effort: 10 })
      .toBuffer();
  }

  if (output.length > 512 * 1024) {
    throw new Error("STICKER_TOO_LARGE");
  }

  return output;
}

async function telegramMultipart(method, fields, fileBuffer) {
  const form = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    form.append(
      key,
      typeof value === "string" ? value : JSON.stringify(value)
    );
  }

  form.append("stickerfile", fileBuffer, {
    filename: "sticker.png",
    contentType: "image/png"
  });

  const response = await axios.post(
    `https://api.telegram.org/bot${TOKEN}/${method}`,
    form,
    {
      headers: form.getHeaders(),
      timeout: 120000,
      maxBodyLength: 2 * 1024 * 1024
    }
  );

  if (!response.data.ok) {
    throw new Error(response.data.description || "TELEGRAM_API_ERROR");
  }

  return response.data.result;
}

async function createOrAddPack(userId, stickerBuffer) {
  const packName =
    `cut_${userId}_by_${botUsername}`.toLowerCase();

  const sticker = {
    sticker: "attach://stickerfile",
    format: "static",
    emoji_list: ["✨"]
  };

  const createFields = {
    user_id: String(userId),
    name: packName,
    title: "استیکرهای من ✨",
    stickers: [sticker]
  };

  try {
    await telegramMultipart(
      "createNewStickerSet",
      createFields,
      stickerBuffer
    );

    return packName;
  } catch (createError) {
    const description =
      createError.response?.data?.description || "";

    const canTryAdd =
      /already occupied|already exists|STICKERSET_INVALID|stickerset_invalid/i
        .test(description);

    if (!canTryAdd) {
      throw createError;
    }

    await telegramMultipart(
      "addStickerToSet",
      {
        user_id: String(userId),
        name: packName,
        sticker
      },
      stickerBuffer
    );

    return packName;
  }
}

bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
  try {
    await sendMenu(msg.chat.id);
  } catch (error) {
    console.error("START ERROR:", error.message);
  }
});

bot.onText(/^\/menu(?:@\w+)?$/, async (msg) => {
  await sendMenu(msg.chat.id).catch(console.error);
});

bot.on("callback_query", async (query) => {
  const chatId = query.message?.chat.id;
  const userId = query.from.id;
  const action = query.data;

  try {
    await bot.answerCallbackQuery(query.id);

    if (!chatId) return;

    if (action === "menu") {
      await sendMenu(chatId);
      return;
    }

    if (action === "help" || action === "again") {
      await bot.sendMessage(
        chatId,
        "📸 حالا عکس موردنظرت رو بفرست."
      );
      return;
    }

    if (action === "guide") {
      await bot.sendMessage(
        chatId,
        "۱. عکس رو بفرست.\n" +
          "۲. منتظر حذف پس‌زمینه بمون.\n" +
          "۳. روی ساخت پک بزن.\n\n" +
          "برای شفاف موندن پس‌زمینه، عکس خروجی PNG ساخته می‌شه.",
        { reply_markup: mainMenu }
      );
      return;
    }

    if (action === "pack") {
      const sticker = processedImages.get(userId);

      if (!sticker) {
        await bot.sendMessage(
          chatId,
          "اول یک عکس بفرست تا پردازش بشه. 🌙",
          { reply_markup: mainMenu }
        );
        return;
      }

      await bot.sendMessage(
        chatId,
        "📦 دارم پک استیکرت رو می‌سازم..."
      );

      const packName = await createOrAddPack(userId, sticker);

      await bot.sendMessage(
        chatId,
        "✨ استیکر به پک اضافه شد!\n\n" +
          `https://t.me/addstickers/${packName}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{
                text: "🎀 باز کردن پک استیکر",
                url: `https://t.me/addstickers/${packName}`
              }],
              [{
                text: "🏠 منوی اصلی",
                callback_data: "menu"
              }]
            ]
          }
        }
      );
    }
  } catch (error) {
    console.error(
      "BUTTON ERROR:",
      error.response?.data || error.message
    );

    await bot.sendMessage(
      chatId,
      "❌ ساخت پک انجام نشد.\n" +
        "ممکنه محدودیت تلگرام یا خطای سرویس وجود داشته باشه. " +
        "کمی بعد دوباره امتحان کن."
    ).catch(() => {});
  }
});

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const photos = msg.photo || [];
    const photo = photos[photos.length - 1];

    if (!photo) {
      await bot.sendMessage(chatId, "عکس معتبر دریافت نشد.");
      return;
    }

    if (photo.file_size && photo.file_size > 15 * 1024 * 1024) {
      await bot.sendMessage(
        chatId,
        "عکس خیلی بزرگه؛ لطفاً عکس کوچک‌تری بفرست."
      );
      return;
    }

    const status = await bot.sendMessage(
      chatId,
      "⏳ عکس رسید؛ دارم پس‌زمینه‌ش رو حذف می‌کنم..."
    );

    const original = await getPhotoBuffer(photo.file_id);
    const transparent = await removeBackground(original);
    const sticker = await makeSticker(transparent);

    processedImages.set(userId, sticker);

    await bot.sendDocument(
      chatId,
      transparent,
      {
        caption: "✨ اینم عکس با پس‌زمینه شفاف!",
        filename: "transparent.png",
        contentType: "image/png",
        reply_markup: photoMenu()
      }
    );

    await bot.deleteMessage(chatId, status.message_id)
      .catch(() => {});
  } catch (error) {
    const statusCode = error.response?.status;
    const apiDescription =
      error.response?.data?.errors?.[0]?.title ||
      error.response?.data?.description ||
      error.message;

    console.error("PHOTO ERROR:", statusCode, apiDescription);

    let message = "❌ پردازش عکس ناموفق بود.";

    if (statusCode === 402 || statusCode === 403) {
      message += "\nکلید یا اعتبار Remove.bg رو بررسی کن.";
    } else if (statusCode === 429) {
      message += "\nسهمیه یا محدودیت درخواست‌ها پر شده.";
    } else if (error.message === "STICKER_TOO_LARGE") {
      message += "\nحجم استیکر بیشتر از حد مجازه.";
    }

    await bot.sendMessage(
      chatId,
      message + "\nلطفاً دوباره امتحان کن یا عکس دیگه‌ای بفرست.",
      { reply_markup: mainMenu }
    ).catch(() => {});
  }
});

bot.on("polling_error", (error) => {
  console.error("POLLING ERROR:", error.message);
});

bot.getMe()
  .then((me) => {
    botUsername = me.username;
    console.log(`Sticker bot started: @${botUsername}`);
  })
  .catch((error) => {
    console.error("BOT AUTH ERROR:", error.message);
    process.exit(1);
  });

process.on("unhandledRejection", (error) => {
  console.error("UNHANDLED ERROR:", error);
});
