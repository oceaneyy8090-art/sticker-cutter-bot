
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
const pending = new Map();
const sessions = new Map();

const menu = {
  inline_keyboard: [
    [{ text: "✂️ حذف پس‌زمینه", callback_data: "remove" }],
    [{ text: "📦 ساخت پک مشترک", callback_data: "create_pack" }],
    [{ text: "➕ افزودن به پک", callback_data: "add_pack" }]
  ]
};

function session(id) {
  if (!sessions.has(id)) sessions.set(id, {});
  return sessions.get(id);
}

bot.onText(/^\/start$/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    "🌙 عکس رو بفرست تا پس‌زمینه‌ش حذف بشه.\n" +
    "بعد می‌تونی استیکر بسازی یا به پک مشترک اضافه کنی.",
    { reply_markup: menu }
  );
});

bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const id = q.from.id;
  const s = session(id);

  await bot.answerCallbackQuery(q.id).catch(() => {});

  if (q.data === "remove") {
    pending.set(id, "photo");
    return bot.sendMessage(chatId, "📸 عکست رو بفرست.");
  }

  if (q.data === "create_pack") {
    pending.set(id, "pack_title");
    return bot.sendMessage(
      chatId,
      "اسم نمایشی پک رو بفرست.\n" +
      "مثلاً: My Cute Stickers"
    );
  }

  if (q.data === "add_pack") {
    pending.set(id, "pack_name");
    return bot.sendMessage(
      chatId,
      "نام کاربری پک رو بفرست؛ مثلاً MyCutePack_by_BotName"
    );
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
  let result = await sharp(buffer)
    .resize(512, 512, {
      fit: "inside",
      withoutEnlargement: true
    })
    .png({ compressionLevel: 9 })
    .toBuffer();

  if (result.length > 512 * 1024) {
    result = await sharp(buffer)
      .resize(384, 384, { fit: "inside" })
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();
  }

  if (result.length > 512 * 1024) {
    throw new Error("حجم استیکر بیش از حد مجاز است");
  }

  return result;
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
  const safeName = me.username.replace(/[^a-zA-Z0-9_]/g, "");
  const packName = `shared_${userId}_by_${safeName}`;

  await uploadSticker(
    "createNewStickerSet",
    {
      user_id: userId,
      name: packName,
      title: title.slice(0, 64),
      stickers: [{
        sticker: "attach://sticker",
        format: "static",
        emoji_list: ["✨"]
      }]
    },
    sticker
  );

  return packName;
}

async function addToPack(userId, packName, sticker) {
  await uploadSticker(
    "addStickerToSet",
    {
      user_id: userId,
      name: packName,
      sticker: {
        sticker: "attach://sticker",
        format: "static",
        emoji_list: ["✨"]
      }
    },
    sticker
  );
}

bot.on("photo", async (msg) => {
  const id = msg.from.id;
  const chatId = msg.chat.id;

  try {
    await bot.sendMessage(chatId, "⏳ دارم پس‌زمینه رو حذف می‌کنم...");

    const photo = msg.photo[msg.photo.length - 1];
    const original = await getFile(photo.file_id);
    const transparent = await removeBackground(original);
    const sticker = await makeSticker(transparent);

    const s = session(id);
    s.sticker = sticker;

    await bot.sendDocument(chatId, transparent, {
      filename: "transparent.png",
      caption: "✨ عکس شفاف آماده شد!",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📦 ساخت پک جدید", callback_data: "create_pack" }],
          [{ text: "➕ افزودن به پک", callback_data: "add_pack" }],
          [{ text: "🏠 منوی اصلی", callback_data: "home" }]
        ]
      }
    });
  } catch (error) {
    console.error("PHOTO ERROR:", error.response?.data || error.message);
    await bot.sendMessage(
      chatId,
      "❌ پردازش ناموفق بود. کلید Remove.bg، اعتبار و حجم عکس رو بررسی کن."
    ).catch(() => {});
  }
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const id = msg.from.id;
  const chatId = msg.chat.id;
  const action = pending.get(id);
  const s = session(id);

  try {
    if (action === "pack_title") {
      if (!s.sticker) {
        pending.delete(id);
        return bot.sendMessage(chatId, "اول یک عکس بفرست تا استیکر آماده بشه.");
      }

      const title = msg.text.trim();
      if (title.length < 1 || title.length > 64) {
        return bot.sendMessage(chatId, "اسم پک باید بین ۱ تا ۶۴ حرف باشه.");
      }

      const packName = await createPack(id, title, s.sticker);
      pending.delete(id);

      return bot.sendMessage(
        chatId,
        `✨ پک ساخته شد!\nhttps://t.me/addstickers/${packName}`
      );
    }

    if (action === "pack_name") {
      if (!s.sticker) {
        pending.delete(id);
        return bot.sendMessage(chatId, "اول یک عکس بفرست.");
      }

      const packName = msg.text.trim().replace(/^https?:\/\/t\.me\/addstickers\//, "");
      if (!/^[A-Za-z0-9_]{1,64}$/.test(packName)) {
        return bot.sendMessage(chatId, "نام پک معتبر نیست؛ دوباره بفرست.");
      }

      await addToPack(id, packName, s.sticker);
      pending.delete(id);

      return bot.sendMessage(
        chatId,
        `✨ استیکر اضافه شد!\nhttps://t.me/addstickers/${packName}`
      );
    }
  } catch (error) {
    console.error("PACK ERROR:", error.response?.data || error.message);
    pending.delete(id);
    await bot.sendMessage(
      chatId,
      "❌ عملیات انجام نشد. نام پک، سازندهٔ پک و دسترسی تلگرام رو بررسی کن."
    ).catch(() => {});
  }
});

bot.on("polling_error", (error) => {
  console.error("POLLING ERROR:", error.message);
});

console.log("Sticker bot started");
