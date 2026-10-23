const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const FormData = require("form-data");
const sharp = require("sharp");

const TOKEN = process.env.BOT_TOKEN;
const REMOVE_BG_KEY = process.env.REMOVE_BG_API_KEY;

if (!TOKEN || !REMOVE_BG_KEY) {
  throw new Error("BOT_TOKEN یا REMOVE_BG_API_KEY تنظیم نشده");
}

const bot = new TelegramBot(TOKEN, { polling: true });

// اطلاعات موقت کاربران
const sessions = new Map();
const pending = new Map();
const userPacks = new Map();

const mainMenu = {
  inline_keyboard: [
    [{ text: "✂️ حذف پس‌زمینه و ساخت استیکر", callback_data: "remove" }],
    [{ text: "📦 پک‌های من", callback_data: "my_packs" }]
  ]
};

function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, {});
  return sessions.get(id);
}

function getPacks(id) {
  if (!userPacks.has(id)) userPacks.set(id, []);
  return userPacks.get(id);
}

bot.onText(/^\/start$/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    "🌙 خوش اومدی!\n\nعکست رو بفرست تا پس‌زمینه‌ش حذف بشه و بتونی استیکرش کنی.",
    { reply_markup: mainMenu }
  );
});

bot.on("callback_query", async (q) => {
  const id = q.from.id;
  const chatId = q.message.chat.id;
  const s = getSession(id);

  await bot.answerCallbackQuery(q.id).catch(() => {});

  if (q.data === "remove") {
    pending.set(id, "photo");
    return bot.sendMessage(chatId, "📸 عکسی که می‌خوای تبدیل به استیکر بشه بفرست.");
  }

  if (q.data === "home") {
    pending.delete(id);
    return bot.sendMessage(chatId, "🏠 منوی اصلی", {
      reply_markup: mainMenu
    });
  }

  if (q.data === "my_packs") {
    const packs = getPacks(id);

    if (!packs.length) {
      return bot.sendMessage(
        chatId,
        "📦 هنوز پکی نساختی. اول یک عکس بفرست و بعد «ساخت پک جدید» رو بزن."
      );
    }

    const keyboard = packs.map((pack, i) => [
      {
        text: `📦 ${pack.title}`,
        callback_data: `choose_pack:${i}`
      }
    ]);

    return bot.sendMessage(chatId, "📚 پک موردنظرت رو انتخاب کن:", {
      reply_markup: { inline_keyboard: keyboard }
    });
  }

  if (q.data === "create_pack") {
    if (!s.sticker) {
      return bot.sendMessage(chatId, "اول یک عکس بفرست.");
    }

    pending.set(id, "pack_title");
    return bot.sendMessage(chatId, "✨ اسم نمایشی پک جدیدت رو بفرست:");
  }

  if (q.data === "add_pack") {
    const packs = getPacks(id);

    if (!s.sticker) {
      return bot.sendMessage(chatId, "اول یک عکس بفرست.");
    }

    if (!packs.length) {
      pending.set(id, "pack_title");
      return bot.sendMessage(
        chatId,
        "هنوز پکی نداری؛ اسم پک جدیدت رو بفرست:"
      );
    }

    const keyboard = packs.map((pack, i) => [
      {
        text: `➕ ${pack.title}`,
        callback_data: `choose_pack:${i}`
      }
    ]);

    return bot.sendMessage(chatId, "این استیکر بره توی کدوم پک؟", {
      reply_markup: { inline_keyboard: keyboard }
    });
  }

  if (q.data.startsWith("choose_pack:")) {
    const index = Number(q.data.split(":")[1]);
    const packs = getPacks(id);
    const pack = packs[index];

    if (!pack || !s.sticker) {
      return bot.sendMessage(chatId, "پک یا استیکر پیدا نشد؛ دوباره امتحان کن.");
    }

    try {
      await bot.sendMessage(chatId, "⏳ دارم استیکر رو به پک اضافه می‌کنم...");

      await uploadSticker(
        "addStickerToSet",
        {
          user_id: id,
          name: pack.name,
          sticker: {
            sticker: "attach://sticker",
            format: "static",
            emoji_list: ["✨"]
          }
        },
        s.sticker
      );

      await bot.sendMessage(
        chatId,
        `✨ استیکر به پک اضافه شد!\n\n🔗 https://t.me/addstickers/${pack.name}`
      );
    } catch (error) {
      console.error("ADD PACK ERROR:", error.response?.data || error.message);
      await bot.sendMessage(
        chatId,
        "❌ نتونستم استیکر رو اضافه کنم. ممکنه پک حذف شده باشه یا محدودیت تلگرام اجازه نده."
      );
    }
  }
});

async function getFile(fileId) {
  const file = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;

  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 60000
  });

  return Buffer.from(response.data);
}

async function removeBackground(buffer) {
  const form = new FormData();

  form.append("image_file", buffer, {
    filename: "photo.jpg",
    contentType: "application/octet-stream"
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
      timeout: 120000
    }
  );

  return Buffer.from(response.data);
}

async function makeSticker(buffer) {
  const resized = await sharp(buffer)
    .resize(512, 512, {
      fit: "inside",
      withoutEnlargement: true
    })
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();

  if (resized.length > 512 * 1024) {
    throw new Error("حجم استیکر بیشتر از حد مجازه.");
  }

  return resized;
}

async function uploadSticker(method, fields, buffer) {
  const form = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    form.append(
      key,
      typeof value === "object" ? JSON.stringify(value) : String(value)
    );
  }

  form.append("sticker", buffer, {
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
    throw new Error(response.data.description || "Telegram API error");
  }

  return response.data.result;
}

async function createPack(userId, title, sticker) {
  const me = await bot.getMe();
  const botName = me.username.replace(/[^a-zA-Z0-9_]/g, "");
  const packName = `user${userId}_pack${Date.now()}_by_${botName}`;

  await uploadSticker(
    "createNewStickerSet",
    {
      user_id: userId,
      name: packName,
      title: title.slice(0, 64),
      stickers: [
        {
          sticker: "attach://sticker",
          format: "static",
          emoji_list: ["✨"]
        }
      ]
    },
    sticker
  );

  return packName;
}

bot.on("photo", async (msg) => {
  const id = msg.from.id;
  const chatId = msg.chat.id;
  const s = getSession(id);

  try {
    await bot.sendMessage(chatId, "⏳ دارم پس‌زمینه رو حذف می‌کنم...");

    const photo = msg.photo[msg.photo.length - 1];
    const original = await getFile(photo.file_id);
    const transparent = await removeBackground(original);
    const sticker = await makeSticker(transparent);

    s.sticker = sticker;

    await bot.sendDocument(chatId, transparent, {
      filename: "transparent.png",
      caption: "✨ عکس شفاف آماده شد!\n\nاین استیکر رو توی کدوم پک بذارم؟",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📦 ساخت پک جدید", callback_data: "create_pack" }],
          [{ text: "➕ افزودن به پک‌های من", callback_data: "add_pack" }],
          [{ text: "📚 نمایش پک‌های من", callback_data: "my_packs" }],
          [{ text: "🏠 منوی اصلی", callback_data: "home" }]
        ]
      }
    });
  } catch (error) {
    console.error("PHOTO ERROR:", error.response?.data || error.message);

    await bot.sendMessage(
      chatId,
      "❌ پردازش ناموفق بود. کلید Remove.bg، اعتبار سرویس و حجم عکس رو بررسی کن."
    ).catch(() => {});
  }
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const id = msg.from.id;
  const chatId = msg.chat.id;
  const action = pending.get(id);
  const s = getSession(id);

  if (action !== "pack_title") return;

  if (!s.sticker) {
    pending.delete(id);
    return bot.sendMessage(chatId, "اول یک عکس بفرست.");
  }

  const title = msg.text.trim();

  if (!title || title.length > 64) {
    return bot.sendMessage(chatId, "اسم پک باید بین ۱ تا ۶۴ کاراکتر باشه.");
  }

  try {
    pending.delete(id);
    await bot.sendMessage(chatId, "⏳ دارم پک اختصاصی‌ات رو می‌سازم...");

    const packName = await createPack(id, title, s.sticker);

    getPacks(id).push({
      title,
      name: packName
    });

    await bot.sendMessage(
      chatId,
      `🎉 پک اختصاصی‌ات ساخته شد!\n\n🔗 https://t.me/addstickers/${packName}`,
      { reply_markup: mainMenu }
    );
  } catch (error) {
    console.error("CREATE PACK ERROR:", error.response?.data || error.message);

    await bot.sendMessage(
      chatId,
      "❌ ساخت پک ناموفق بود. ممکنه نام پک یا فرمت استیکر از طرف تلگرام رد شده باشه."
    ).catch(() => {});
  }
});

bot.on("polling_error", (error) => {
  console.error("POLLING ERROR:", error.message);
});

console.log("Sticker bot started");