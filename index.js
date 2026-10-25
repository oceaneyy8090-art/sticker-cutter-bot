
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const FormData = require("form-data");
const sharp = require("sharp");

const TOKEN = process.env.BOT_TOKEN;
const REMOVE_BG_KEY = process.env.REMOVE_BG_API_KEY;

if (!TOKEN || !REMOVE_BG_KEY) {
  throw new Error("BOT_TOKEN یا REMOVE_BG_API_KEY تنظیم نشده است.");
}

const bot = new TelegramBot(TOKEN, { polling: true });

const sessions = new Map();
const pending = new Map();
const userPacks = new Map();

const mainMenu = {
  inline_keyboard: [
    [{ text: "✂️ ساخت استیکر", callback_data: "remove" }],
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

function errorDetails(error) {
  const data = error.response?.data;

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  if (data && typeof data === "object") {
    return JSON.stringify(data);
  }

  return data || error.message || "خطای نامشخص";
}

function userError(error) {
  const status = error.response?.status;
  console.error("PHOTO ERROR:", status || "", errorDetails(error));

  if (status === 401 || status === 403) {
    return "کلید Remove.bg نامعتبر است یا دسترسی ندارد.";
  }

  if (status === 402) {
    return "اعتبار Remove.bg کافی نیست.";
  }

  if (status === 429) {
    return "تعداد درخواست‌ها زیاد شده؛ کمی بعد دوباره امتحان کن.";
  }

  if (error.code === "ECONNABORTED") {
    return "پردازش عکس طول کشید؛ دوباره امتحان کن.";
  }

  return "پردازش ناموفق بود. جزئیات خطا در GitHub Actions ثبت شده است.";
}

bot.onText(/^\/start$/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    "🌙 به استیکرساز خوش اومدی!\nعکست رو بفرست تا پس‌زمینه‌ش رو حذف کنیم.",
    { reply_markup: mainMenu }
  );
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
      timeout: 120000,
      maxBodyLength: 20 * 1024 * 1024
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
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();

  if (result.length > 512 * 1024) {
    result = await sharp(buffer)
      .resize(384, 384, { fit: "inside" })
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();
  }

  if (result.length > 512 * 1024) {
    throw new Error("حجم استیکر بیشتر از حد مجاز است.");
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
    throw new Error(response.data.description || "خطای Telegram API");
  }

  return response.data.result;
}

async function createPack(userId, title, sticker) {
  const me = await bot.getMe();
  const botName = me.username.replace(/[^a-zA-Z0-9_]/g, "");
  const packName = `user${userId}_${Date.now()}_by_${botName}`;

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

  const pack = { title, name: packName };
  getPacks(userId).push(pack);

  return pack;
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

function packKeyboard(id) {
  const rows = [
    [{ text: "📦 ساخت پک جدید", callback_data: "create_pack" }]
  ];

  getPacks(id).forEach((pack, index) => {
    rows.push([{
      text: `➕ ${pack.title}`,
      callback_data: `choose_pack:${index}`
    }]);
  });

  rows.push([{ text: "🏠 منوی اصلی", callback_data: "home" }]);

  return { inline_keyboard: rows };
}

bot.on("callback_query", async (q) => {
  await bot.answerCallbackQuery(q.id).catch(() => {});

  const id = q.from.id;
  const chatId = q.message.chat.id;
  const s = getSession(id);

  try {
    if (q.data === "home") {
      return bot.sendMessage(chatId, "🏠 منوی اصلی", {
        reply_markup: mainMenu
      });
    }

    if (q.data === "remove") {
      pending.set(id, "photo");
      return bot.sendMessage(chatId, "📸 عکست رو بفرست.");
    }

    if (q.data === "my_packs") {
      if (!getPacks(id).length) {
        return bot.sendMessage(chatId, "هنوز پکی نداری؛ اول یک استیکر بساز.");
      }

      return bot.sendMessage(chatId, "📚 پک‌هات:", {
        reply_markup: packKeyboard(id)
      });
    }

    if (q.data === "create_pack") {
      if (!s.sticker) {
        return bot.sendMessage(chatId, "اول یک عکس بفرست.");
      }

      pending.set(id, "pack_title");
      return bot.sendMessage(chatId, "✨ اسم نمایشی پک جدیدت رو بفرست:");
    }

    if (q.data.startsWith("choose_pack:")) {
      const index = Number(q.data.split(":")[1]);
      const pack = getPacks(id)[index];

      if (!pack || !s.sticker) {
        return bot.sendMessage(chatId, "پک یا استیکر پیدا نشد.");
      }

      await bot.sendMessage(chatId, "⏳ دارم استیکر رو اضافه می‌کنم...");
      await addToPack(id, pack.name, s.sticker);

      return bot.sendMessage(
        chatId,
        `✨ استیکر اضافه شد!\n🔗 https://t.me/addstickers/${pack.name}`,
        { reply_markup: mainMenu }
      );
    }
  } catch (error) {
    console.error("CALLBACK ERROR:", errorDetails(error));

    return bot.sendMessage(
      chatId,
      "❌ انجام این کار ناموفق بود. جزئیات در GitHub Actions ثبت شده است."
    ).catch(() => {});
  }
});

bot.on("photo", async (msg) => {
  const id = msg.from.id;
  const chatId = msg.chat.id;
  const s = getSession(id);

  try {
    await bot.sendMessage(chatId, "⏳ دارم استیکرت رو آماده می‌کنم...");

    const photo = msg.photo[msg.photo.length - 1];
    const original = await getFile(photo.file_id);
    const transparent = await removeBackground(original);
    const sticker = await makeSticker(transparent);

    s.sticker = sticker;

    let previewPack = getPacks(id)[0];

    if (!previewPack) {
      await bot.sendMessage(chatId, "📦 دارم اولین پک اختصاصی‌ات رو می‌سازم...");
      previewPack = await createPack(id, "My Stickers", sticker);
    } else {
      await addToPack(id, previewPack.name, sticker);
    }

    await bot.sendSticker(chatId, sticker);

    await bot.sendMessage(
      chatId,
      "💫 استیکرت آماده شد! می‌تونی پک رو انتخاب کنی یا پک جدید بسازی.",
      { reply_markup: packKeyboard(id) }
    );
  } catch (error) {
    console.error(
      "PHOTO ERROR:",
      error.response?.status || "",
      errorDetails(error)
    );

    await bot.sendMessage(chatId, userError(error)).catch(() => {});
  }
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const id = msg.from.id;
  const chatId = msg.chat.id;

  if (pending.get(id) !== "pack_title") return;

  const s = getSession(id);

  if (!s.sticker) {
    pending.delete(id);
    return bot.sendMessage(chatId, "اول یک عکس بفرست.");
  }

  const title = msg.text.trim();

  if (!title || title.length > 64) {
    return bot.sendMessage(chatId, "اسم پک باید بین ۱ تا ۶۴ کاراکتر باشه.");
  }

  pending.delete(id);

  try {
    await bot.sendMessage(chatId, "⏳ دارم پک جدیدت رو می‌سازم...");

    const pack = await createPack(id, title, s.sticker);

    await bot.sendMessage(
      chatId,
      `🎉 پک ساخته شد!\n🔗 https://t.me/addstickers/${pack.name}`,
      { reply_markup: mainMenu }
    );
  } catch (error) {
    console.error("CREATE ERROR:", errorDetails(error));

    await bot.sendMessage(
      chatId,
      "❌ ساخت پک ناموفق بود. جزئیات در GitHub Actions ثبت شده است."
    );
  }
});

bot.on("polling_error", (error) => {
  console.error("POLLING ERROR:", error.message);
});

console.log("Sticker bot started");
