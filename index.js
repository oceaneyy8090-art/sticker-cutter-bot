
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const FormData = require("form-data");
const sharp = require("sharp");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const TOKEN = process.env.BOT_TOKEN;
const REMOVE_BG_KEY = process.env.REMOVE_BG_API_KEY;

if (!TOKEN || !REMOVE_BG_KEY) {
  throw new Error("BOT_TOKEN و REMOVE_BG_API_KEY تنظیم نشده‌اند.");
}

const bot = new TelegramBot(TOKEN, { polling: true });
const sessions = new Map();
const pending = new Map();
const userPacks = new Map();

const MAX_VIDEO_SIZE = 256 * 1024;

async function downloadFile(fileId) {
  const url = await bot.getFileLink(fileId);
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 120000
  });
  return Buffer.from(response.data);
}

async function removeBackground(buffer) {
  const form = new FormData();

  form.append("image_file", buffer, {
    filename: "image.png",
    contentType: "image/png"
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

async function makePhotoSticker(input) {
  const transparent = await removeBackground(input);

  return sharp(transparent)
    .resize(512, 512, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .webp({ quality: 85, alphaQuality: 100 })
    .toBuffer();
}

async function makeVideoSticker(input) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "transparent-sticker-")
  );

  try {
    const inputPath = path.join(dir, "input.mp4");

    await fs.writeFile(inputPath, input);

    // استخراج حداکثر ۳ ثانیه با ۶ فریم در ثانیه
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-t", "3",
      "-vf",
      "fps=6,scale=512:512:force_original_aspect_ratio=decrease",
      "-frames:v", "18",
      path.join(dir, "raw_%03d.png")
    ]);

    const rawFrames = (await fs.readdir(dir))
      .filter(name => /^raw_\d+\.png$/.test(name))
      .sort();

    if (!rawFrames.length) {
      throw new Error("هیچ فریمی از ویدیو استخراج نشد.");
    }

    // حذف پس‌زمینه از تک‌تک فریم‌ها
    for (let i = 0; i < rawFrames.length; i++) {
      const raw = await fs.readFile(
        path.join(dir, rawFrames[i])
      );

      const transparent = await removeBackground(raw);

      const frame = await sharp(transparent)
        .resize(512, 512, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .png()
        .toBuffer();

      const frameName =
        `frame_${String(i + 1).padStart(3, "0")}.png`;

      await fs.writeFile(path.join(dir, frameName), frame);
    }

    const outputPath = path.join(dir, "sticker.webm");

    // فشرده‌سازی ویدیوی شفاف برای تلگرام
    let result;

    for (const crf of [35, 40, 45, 50]) {
      await execFileAsync("ffmpeg", [
        "-y",
        "-framerate", "6",
        "-i", path.join(dir, "frame_%03d.png"),
        "-frames:v", String(rawFrames.length),
        "-an",
        "-c:v", "libvpx-vp9",
        "-pix_fmt", "yuva420p",
        "-auto-alt-ref", "0",
        "-b:v", "0",
        "-crf", String(crf),
        outputPath
      ]);

      result = await fs.readFile(outputPath);

      if (result.length <= MAX_VIDEO_SIZE) {
        return result;
      }
    }

    throw new Error(
      "حجم ویدیو پس از فشرده‌سازی هنوز بیشتر از ۲۵۶ کیلوبایت است."
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function sendSticker(chatId, userId, buffer, format) {
  const isVideo = format === "video";
  const filename = isVideo ? "sticker.webm" : "sticker.webp";
  const contentType = isVideo ? "video/webm" : "image/webp";

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
    fileId: sent.sticker.file_id
  });

  await bot.sendMessage(chatId, "استیکرت آماده شد! ✨", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📦 ساخت پک جدید", callback_data: "newpack" }],
        [{ text: "➕ افزودن به پک", callback_data: "addpack" }]
      ]
    }
  });
}

function getErrorMessage(error) {
  const data = error.response?.data;

  if (data) {
    try {
      const parsed = JSON.parse(Buffer.from(data).toString("utf8"));
      return parsed.message || parsed.description || error.message;
    } catch (_) {
      return error.message;
    }
  }

  return error.message;
}

async function processPhoto(msg) {
  const chatId = msg.chat.id;

  try {
    await bot.sendMessage(
      chatId,
      "دارم پس‌زمینهٔ عکس رو حذف می‌کنم... 🌙"
    );

    const photo = msg.photo[msg.photo.length - 1];
    const input = await downloadFile(photo.file_id);
    const sticker = await makePhotoSticker(input);

    await sendSticker(chatId, msg.from.id, sticker, "static");
  } catch (error) {
    console.error("PHOTO ERROR:", getErrorMessage(error));

    await bot.sendMessage(
      chatId,
      "ساخت استیکر عکس ناموفق بود. کلید Remove.bg و اعتبار API رو بررسی کن."
    );
  }
}

async function processVideo(msg, fileId) {
  const chatId = msg.chat.id;

  try {
    await bot.sendMessage(
      chatId,
      "دارم پس‌زمینهٔ فریم‌های فیلم رو حذف می‌کنم؛ کمی صبر کن... 🌙"
    );

    const input = await downloadFile(fileId);
    const sticker = await makeVideoSticker(input);

    await sendSticker(chatId, msg.from.id, sticker, "video");
  } catch (error) {
    console.error("VIDEO ERROR:", getErrorMessage(error));

    await bot.sendMessage(
      chatId,
      "ساخت استیکر فیلم ناموفق بود.\n" +
      "ممکنه اعتبار API تموم شده باشه، فرمت فیلم پشتیبانی نشه " +
      "یا حجم استیکر از محدودیت تلگرام بیشتر باشه."
    );
  }
}

function makePackName(title, username) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);

  if (slug.length < 3) {
    throw new Error(
      "اسم پک باید حداقل ۳ حرف انگلیسی یا عدد داشته باشه."
    );
  }

  return `${slug}_by_${username}`;
}

async function telegramMultipart(method, fields, buffer, filename, contentType) {
  const form = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    form.append(
      key,
      typeof value === "string" ? value : JSON.stringify(value)
    );
  }

  // نام فایل جداست تا با فیلد JSON استیکر تداخل نداشته باشد.
  form.append("sticker_file", buffer, {
    filename,
    contentType
  });

  const response = await axios.post(
    `https://api.telegram.org/bot${TOKEN}/${method}`,
    form,
    {
      headers: form.getHeaders(),
      timeout: 120000,
      maxBodyLength: Infinity
    }
  );

  if (!response.data.ok) {
    throw new Error(response.data.description || "خطای تلگرام");
  }

  return response.data.result;
}

async function createPack(userId, title, chatId) {
  const session = sessions.get(String(userId));

  if (!session) {
    return bot.sendMessage(chatId, "اول یک عکس یا فیلم بفرست.");
  }

  try {
    const me = await bot.getMe();
    const name = makePackName(title, me.username);

    await telegramMultipart(
      "createNewStickerSet",
      {
        user_id: String(userId),
        name,
        title: title.slice(0, 64),
        stickers: [{
          sticker: "attach://sticker_file",
          format: session.format,
          emoji_list: ["✨"]
        }]
      },
      session.buffer,
      session.filename,
      session.contentType
    );

    const link = `https://t.me/addstickers/${name}`;
    const packs = userPacks.get(String(userId)) || [];

    packs.push({ name, title, link });
    userPacks.set(String(userId), packs);

    await bot.sendMessage(
      chatId,
      `پک ساخته شد! ✨\n${link}`
    );
  } catch (error) {
    console.error("CREATE PACK ERROR:", getErrorMessage(error));

    await bot.sendMessage(
      chatId,
      `ساخت پک ناموفق بود:\n${getErrorMessage(error)}`
    );
  }
}

async function addToPack(userId, packName, chatId) {
  const session = sessions.get(String(userId));

  if (!session) {
    return bot.sendMessage(chatId, "اول یک استیکر بساز.");
  }

  try {
    await telegramMultipart(
      "addStickerToSet",
      {
        user_id: String(userId),
        name: packName,
        sticker: {
          sticker: "attach://sticker_file",
          format: session.format,
          emoji_list: ["✨"]
        }
      },
      session.buffer,
      session.filename,
      session.contentType
    );

    await bot.sendMessage(chatId, "استیکر به پک اضافه شد! ✨");
  } catch (error) {
    console.error("ADD PACK ERROR:", getErrorMessage(error));

    await bot.sendMessage(
      chatId,
      `افزودن استیکر ناموفق بود:\n${getErrorMessage(error)}`
    );
  }
}

bot.onText(/^\/start$/, async msg => {
  await bot.sendMessage(
    msg.chat.id,
    "سلام! 🍄\n\n" +
    "عکس یا فیلم کوتاه بفرست تا پس‌زمینه‌ش رو حذف کنم " +
    "و به استیکر تبدیلش کنم.\n\n" +
    "بعدش می‌تونی پک خودت رو بسازی.",
    {
      reply_markup: {
        keyboard: [["📦 پک‌های من"]],
        resize_keyboard: true
      }
    }
  );
});

bot.on("photo", processPhoto);

bot.on("video", msg => {
  processVideo(msg, msg.video.file_id);
});

bot.on("animation", msg => {
  processVideo(msg, msg.animation.file_id);
});

bot.on("document", msg => {
  if (msg.document?.mime_type?.startsWith("video/")) {
    processVideo(msg, msg.document.file_id);
  }
});

bot.on("callback_query", async query => {
  const userId = String(query.from.id);
  const chatId = query.message.chat.id;

  await bot.answerCallbackQuery(query.id);

  if (query.data === "newpack") {
    pending.set(userId, "newpack");

    return bot.sendMessage(
      chatId,
      "اسم پک رو بفرست. بهتره انگلیسی و کوتاه باشه."
    );
  }

  if (query.data === "addpack") {
    const packs = userPacks.get(userId) || [];

    if (!packs.length) {
      pending.set(userId, "addpack");

      return bot.sendMessage(
        chatId,
        "اسم پک خودت رو بفرست؛ فقط پک‌هایی رو می‌تونی ویرایش کنی که مالکشی."
      );
    }

    return bot.sendMessage(chatId, "کدوم پک؟", {
      reply_markup: {
        inline_keyboard: packs.map((pack, index) => [{
          text: pack.title,
          callback_data: `pack:${index}`
        }])
      }
    });
  }

  if (query.data.startsWith("pack:")) {
    const index = Number(query.data.split(":")[1]);
    const packs = userPacks.get(userId) || [];
    const pack = packs[index];

    if (pack) {
      await addToPack(userId, pack.name, chatId);
    }
  }
});

bot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const state = pending.get(userId);

  if (state === "newpack") {
    pending.delete(userId);
    return createPack(userId, msg.text.trim(), chatId);
  }

  if (state === "addpack") {
    pending.delete(userId);

    const input = msg.text.trim();
    const match = input.match(/(?:addstickers\/)?([A-Za-z0-9_]+_by_[A-Za-z0-9_]+)/);
    const name = match ? match[1] : input;

    return addToPack(userId, name, chatId);
  }

  if (msg.text === "📦 پک‌های من") {
    const packs = userPacks.get(userId) || [];

    if (!packs.length) {
      return bot.sendMessage(
        chatId,
        "هنوز در این نشست پک نساختی."
      );
    }

    return bot.sendMessage(
      chatId,
      packs.map(pack => `${pack.title}\n${pack.link}`).join("\n\n")
    );
  }
});

bot.on("polling_error", error => {
  console.error("POLLING ERROR:", error.message);
});

console.log("🌙 Sticker bot is running...");
