
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const FormData = require("form-data");
const sharp = require("sharp");
const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const execFileAsync = promisify(execFile);

const TOKEN = process.env.BOT_TOKEN;
const REMOVE_BG_KEY = process.env.REMOVE_BG_API_KEY;

if (!TOKEN || !REMOVE_BG_KEY) {
  throw new Error("BOT_TOKEN یا REMOVE_BG_API_KEY تنظیم نشده است.");
}

const bot = new TelegramBot(TOKEN, { polling: true });
const sessions = new Map();
const pending = new Map();
const userPacks = new Map();

const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const MAX_STICKER_BYTES = 256 * 1024;

let botUsername = "";

function mainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "✂️ ساخت استیکر از عکس" }],
        [{ text: "📦 پک‌های من" }]
      ],
      resize_keyboard: true
    }
  };
}

function stickerKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "➕ ساخت پک جدید", callback_data: "newpack" },
          { text: "📦 افزودن به پک", callback_data: "addpack" }
        ],
        [{ text: "🔄 ساخت استیکر دیگر", callback_data: "again" }]
      ]
    }
  };
}

function getPacks(userId, format) {
  return (userPacks.get(String(userId)) || [])
    .filter(pack => pack.format === format);
}

function getSession(userId) {
  return sessions.get(String(userId));
}

async function downloadTelegramFile(fileId, maxBytes = MAX_VIDEO_BYTES) {
  const file = await bot.getFile(fileId);

  if (!file.file_path) {
    throw new Error("فایل تلگرام پیدا نشد.");
  }

  const response = await axios.get(
    `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`,
    {
      responseType: "arraybuffer",
      timeout: 120000,
      maxContentLength: maxBytes
    }
  );

  return Buffer.from(response.data);
}

async function removeBackground(imageBuffer) {
  const form = new FormData();

  form.append("image_file", imageBuffer, {
    filename: "image.jpg",
    contentType: "application/octet-stream"
  });

  form.append("size", "auto");

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
      maxBodyLength: Infinity
    }
  );

  return Buffer.from(response.data);
}

async function preparePhotoSticker(imageBuffer) {
  const transparent = await removeBackground(imageBuffer);

  return sharp(transparent)
    .resize(512, 512, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer();
}

async function makeVideoSticker(videoBuffer) {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "telegram-sticker-")
  );

  const input = path.join(folder, "input.mp4");
  const output = path.join(folder, "sticker.webm");

  try {
    await fs.writeFile(input, videoBuffer);

    for (const crf of [32, 38, 44, 50, 55]) {
      try {
        await fs.unlink(output);
      } catch {}

      await execFileAsync("ffmpeg", [
        "-y",
        "-i", input,
        "-t", "3",
        "-an",
        "-vf",
        "scale=512:512:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,format=yuva420p",
        "-c:v", "libvpx-vp9",
        "-pix_fmt", "yuva420p",
        "-b:v", "0",
        "-crf", String(crf),
        "-deadline", "good",
        "-cpu-used", "4",
        "-auto-alt-ref", "0",
        "-f", "webm",
        output
      ], { timeout: 180000 });

      const result = await fs.readFile(output);

      if (result.length <= MAX_STICKER_BYTES) {
        return result;
      }
    }

    throw new Error(
      "حجم ویدئو هنوز بیشتر از ۲۵۶ کیلوبایت است؛ یک فیلم کوتاه‌تر بفرست."
    );
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}

async function telegramMultipart(method, fields, buffer, filename, contentType) {
  const form = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    form.append(
      key,
      typeof value === "string" ? value : JSON.stringify(value)
    );
  }

  if (buffer) {
    form.append("file0", buffer, {
      filename,
      contentType
    });
  }

  const response = await axios.post(
    `https://api.telegram.org/bot${TOKEN}/${method}`,
    form,
    {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      timeout: 120000
    }
  );

  if (!response.data.ok) {
    throw new Error(response.data.description || "خطای تلگرام");
  }

  return response.data.result;
}

async function sendPreparedSticker(chatId, userId, buffer, format) {
  const filename = format === "video" ? "sticker.webm" : "sticker.png";
  const contentType = format === "video" ? "video/webm" : "image/png";

  const sent = await bot.sendSticker(
    chatId,
    buffer,
    {},
    { filename, contentType }
  );

  sessions.set(String(userId), {
    buffer,
    format,
    filename,
    contentType,
    stickerFileId: sent.sticker.file_id
  });

  await bot.sendMessage(
    chatId,
    "استیکرت آماده شد! ✨",
    stickerKeyboard()
  );
}

async function createPack(userId, title) {
  const session = getSession(userId);

  if (!session) {
    throw new Error("اول یک استیکر بساز.");
  }

  const cleanTitle = title.trim().slice(0, 64);

  if (!cleanTitle) {
    throw new Error("اسم پک خالیه.");
  }

  const name =
    `stickers_${userId}_${Date.now()}_by_${botUsername}`.toLowerCase();

  await telegramMultipart(
    "createNewStickerSet",
    {
      user_id: String(userId),
      name,
      title: cleanTitle,
      sticker_type: "regular",
      stickers: [{
        sticker: "attach://file0",
        format: session.format,
        emoji_list: ["✨"]
      }]
    },
    session.buffer,
    session.filename,
    session.contentType
  );

  const pack = {
    name,
    title: cleanTitle,
    format: session.format,
    link: `https://t.me/addstickers/${name}`
  };

  const key = String(userId);
  const packs = userPacks.get(key) || [];

  packs.push(pack);
  userPacks.set(key, packs);

  return pack;
}

async function addToPack(userId, pack) {
  const session = getSession(userId);

  if (!session) {
    throw new Error("اول یک استیکر بساز.");
  }

  if (pack.format !== session.format) {
    throw new Error("نوع استیکر با این پک هماهنگ نیست.");
  }

  await telegramMultipart(
    "addStickerToSet",
    {
      user_id: String(userId),
      name: pack.name,
      sticker: {
        sticker: "attach://file0",
        format: session.format,
        emoji_list: ["✨"]
      }
    },
    session.buffer,
    session.filename,
    session.contentType
  );
}

async function showPackKeyboard(chatId, userId) {
  const session = getSession(userId);

  if (!session) {
    await bot.sendMessage(chatId, "اول یک استیکر بساز.");
    return;
  }

  const packs = getPacks(userId, session.format);

  if (!packs.length) {
    await bot.sendMessage(
      chatId,
      "هنوز پک هم‌نوعی نداری. اول پک جدید بساز."
    );
    return;
  }

  const rows = packs.map((pack, index) => [{
    text: `📦 ${pack.title}`,
    callback_data: `pack:${index}`
  }]);

  await bot.sendMessage(
    chatId,
    "استیکر رو به کدوم پک اضافه کنم؟",
    { reply_markup: { inline_keyboard: rows } }
  );
}

async function processPhoto(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    await bot.sendMessage(chatId, "دارم پس‌زمینه عکس رو حذف می‌کنم... ✂️");

    const photo = msg.photo[msg.photo.length - 1];
    const image = await downloadTelegramFile(photo.file_id);
    const sticker = await preparePhotoSticker(image);

    await sendPreparedSticker(chatId, userId, sticker, "static");
  } catch (error) {
    console.error("Photo error:", error.response?.data || error.message);
    await bot.sendMessage(
      chatId,
      "ساخت استیکر عکس ناموفق بود. دوباره امتحان کن."
    );
  }
}

async function processVideo(msg, media) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (media.file_size && media.file_size > MAX_VIDEO_BYTES) {
    await bot.sendMessage(
      chatId,
      "حجم ویدئو باید کمتر از ۲۰ مگابایت باشه."
    );
    return;
  }

  try {
    await bot.sendMessage(
      chatId,
      "دارم ویدئو رو به استیکر متحرک تبدیل می‌کنم... 🎬"
    );

    const video = await downloadTelegramFile(media.file_id);
    const sticker = await makeVideoSticker(video);

    await sendPreparedSticker(chatId, userId, sticker, "video");
  } catch (error) {
    console.error("Video error:", error.response?.data || error.message);

    await bot.sendMessage(
      chatId,
      `تبدیل ویدئو ناموفق بود:\n${String(error.message).slice(0, 500)}`
    );
  }
}

bot.onText(/\/start/, async msg => {
  pending.delete(String(msg.from.id));

  await bot.sendMessage(
    msg.chat.id,
    "سلام! 🍄\nعکس بفرست تا استیکر بسازم، یا فیلم کوتاه بفرست تا استیکر متحرک بسازم.",
    mainKeyboard()
  );
});

bot.on("photo", processPhoto);

bot.on("video", msg => processVideo(msg, msg.video));

bot.on("animation", msg => processVideo(msg, msg.animation));

bot.on("document", msg => {
  const doc = msg.document;

  if (doc?.mime_type?.startsWith("video/")) {
    return processVideo(msg, doc);
  }
});

bot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const key = String(userId);
  const text = msg.text.trim();

  if (pending.get(key)?.type === "pack_title") {
    pending.delete(key);

    try {
      await bot.sendMessage(chatId, "دارم پک رو می‌سازم... 📦");

      const pack = await createPack(userId, text);

      await bot.sendMessage(
        chatId,
        `پک ساخته شد! 🎉\n${pack.title}\n${pack.link}`,
        mainKeyboard()
      );
    } catch (error) {
      console.error("Create pack error:", error.response?.data || error.message);

      await bot.sendMessage(
        chatId,
        `ساخت پک ناموفق بود:\n${String(error.message).slice(0, 500)}`
      );
    }

    return;
  }

  if (text === "✂️ ساخت استیکر از عکس") {
    await bot.sendMessage(
      chatId,
      "یک عکس بفرست تا پس‌زمینه‌اش رو حذف کنم. 🖼️",
      mainKeyboard()
    );
    return;
  }

  if (text === "📦 پک‌های من") {
    const packs = userPacks.get(key) || [];

    if (!packs.length) {
      await bot.sendMessage(
        chatId,
        "هنوز پکی نساختی. اول یک استیکر بساز.",
        mainKeyboard()
      );
      return;
    }

    const list = packs.map((pack, i) =>
      `${i + 1}. ${pack.format === "video" ? "🎬" : "✨"} ${pack.title}\n${pack.link}`
    );

    await bot.sendMessage(chatId, list.join("\n\n"), mainKeyboard());
  }
});

bot.on("callback_query", async query => {
  const userId = query.from.id;
  const chatId = query.message.chat.id;
  const key = String(userId);
  const data = query.data;

  try {
    await bot.answerCallbackQuery(query.id);

    if (data === "newpack") {
      if (!getSession(userId)) {
        await bot.sendMessage(chatId, "اول یک استیکر بساز.");
        return;
      }

      pending.set(key, { type: "pack_title" });

      await bot.sendMessage(
        chatId,
        "اسم پک جدیدت رو بفرست:"
      );
      return;
    }

    if (data === "addpack") {
      await showPackKeyboard(chatId, userId);
      return;
    }

    if (data === "again") {
      await bot.sendMessage(
        chatId,
        "یک عکس یا ویدئوی کوتاه بفرست.",
        mainKeyboard()
      );
      return;
    }

    if (data.startsWith("pack:")) {
      const session = getSession(userId);

      if (!session) {
        await bot.sendMessage(chatId, "اول یک استیکر بساز.");
        return;
      }

      const index = Number(data.split(":")[1]);
      const packs = getPacks(userId, session.format);
      const pack = packs[index];

      if (!pack) {
        await bot.sendMessage(
          chatId,
          "این پک پیدا نشد یا نوعش با استیکر هماهنگ نیست."
        );
        return;
      }

      await bot.sendMessage(
        chatId,
        "دارم استیکر رو به پک اضافه می‌کنم... 📦"
      );

      await addToPack(userId, pack);

      await bot.sendMessage(
        chatId,
        `استیکر به پک اضافه شد! ✨\n${pack.link}`,
        mainKeyboard()
      );
    }
  } catch (error) {
    console.error("Callback error:", error.response?.data || error.message);

    await bot.sendMessage(
      chatId,
      `عملیات انجام نشد:\n${String(error.message).slice(0, 500)}`
    ).catch(() => {});
  }
});

bot.on("polling_error", error => {
  console.error("Polling error:", error.message);
});

(async () => {
  try {
    const me = await bot.getMe();
    botUsername = me.username;

    console.log(`Sticker bot is running: @${botUsername}`);
  } catch (error) {
    console.error("Startup error:", error.message);
    process.exit(1);
  }
})();
