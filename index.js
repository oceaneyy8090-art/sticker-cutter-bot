
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
  throw new Error(
    "لطفاً BOT_TOKEN و REMOVE_BG_API_KEY را در GitHub Secrets تنظیم کن."
  );
}

const bot = new TelegramBot(TOKEN, { polling: true });

const sessions = new Map();
const pending = new Map();
const userPacks = new Map();

const MAX_VIDEO_SIZE = 256 * 1024;

function describeError(error) {
  const data = error.response?.data;

  if (Buffer.isBuffer(data)) {
    const text = data.toString("utf8");

    try {
      const json = JSON.parse(text);
      return json.description || json.message || text;
    } catch {
      return text.slice(0, 2000);
    }
  }

  if (typeof data === "string") return data;

  return (
    data?.description ||
    data?.message ||
    error.stderr ||
    error.message ||
    "خطای نامشخص"
  );
}

function logError(label, error) {
  console.error(`\n${label}`);
  console.error("STATUS:", error.response?.status || "N/A");
  console.error("DETAIL:", describeError(error));
}

async function downloadFile(fileId) {
  const url = await bot.getFileLink(fileId);

  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 120000
  });

  return Buffer.from(response.data);
}

// حذف پس‌زمینه از یک تصویر
async function removeBackground(buffer) {
  const form = new FormData();

  form.append("image_file", buffer, {
    filename: "frame.png",
    contentType: "image/png"
  });

  form.append("size", "auto");

  let response;

  try {
    response = await axios.post(
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
  } catch (error) {
    logError("REMOVE.BG ERROR", error);
    throw new Error(
      `Remove.bg: ${describeError(error)}`
    );
  }

  return Buffer.from(response.data);
}

// تبدیل عکس به استیکر شفاف
async function makePhotoSticker(input) {
  const transparent = await removeBackground(input);

  return sharp(transparent)
    .resize(512, 512, {
      fit: "contain",
      background: {
        r: 0,
        g: 0,
        b: 0,
        alpha: 0
      }
    })
    .webp({
      quality: 85,
      alphaQuality: 100
    })
    .toBuffer();
}

// تبدیل فیلم کوتاه به استیکر ویدیویی شفاف
async function makeVideoSticker(input) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "sticker-")
  );

  try {
    const inputPath = path.join(dir, "input.mp4");
    const outputPath = path.join(dir, "sticker.webm");

    await fs.writeFile(inputPath, input);

    // استخراج فریم‌ها؛ حداکثر ۳ ثانیه و ۶ فریم در ثانیه
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-i", inputPath,
        "-t", "3",
        "-vf",
        "fps=6,scale=512:512:force_original_aspect_ratio=decrease",
        "-frames:v", "18",
        path.join(dir, "raw_%03d.png")
      ]);
    } catch (error) {
      logError("FFMPEG EXTRACT ERROR", error);
      throw new Error("استخراج فریم‌های فیلم ناموفق بود.");
    }

    const rawFrames = (await fs.readdir(dir))
      .filter(name => /^raw_\d+\.png$/.test(name))
      .sort();

    if (!rawFrames.length) {
      throw new Error("هیچ فریمی از فیلم استخراج نشد.");
    }

    // حذف پس‌زمینهٔ تک‌تک فریم‌ها
    for (let i = 0; i < rawFrames.length; i++) {
      console.log(
        `Processing video frame ${i + 1}/${rawFrames.length}`
      );

      const raw = await fs.readFile(
        path.join(dir, rawFrames[i])
      );

      const transparent = await removeBackground(raw);

      const png = await sharp(transparent)
        .resize(512, 512, {
          fit: "contain",
          background: {
            r: 0,
            g: 0,
            b: 0,
            alpha: 0
          }
        })
        .png()
        .toBuffer();

      const filename =
        `frame_${String(i + 1).padStart(3, "0")}.png`;

      await fs.writeFile(
        path.join(dir, filename),
        png
      );
    }

    // تلاش برای فشرده‌سازی تا رسیدن به محدودیت حجم تلگرام
    let finalBuffer;

    for (const crf of [35, 40, 45, 50]) {
      try {
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
      } catch (error) {
        logError("FFMPEG ENCODE ERROR", error);
        throw new Error("ساخت ویدیوی شفاف ناموفق بود.");
      }

      finalBuffer = await fs.readFile(outputPath);

      console.log(
        `Video size: ${finalBuffer.length} bytes; CRF ${crf}`
      );

      if (finalBuffer.length <= MAX_VIDEO_SIZE) {
        return finalBuffer;
      }
    }

    throw new Error(
      "حجم ویدیوی خروجی از ۲۵۶ کیلوبایت بیشتر است."
    );
  } finally {
    await fs.rm(dir, {
      recursive: true,
      force: true
    });
  }
}

// ارسال استیکر ساخته‌شده به کاربر
async function sendSticker(chatId, userId, buffer, format) {
  const isVideo = format === "video";
  const filename = isVideo ? "sticker.webm" : "sticker.webp";
  const contentType = isVideo ? "video/webm" : "image/webp";

  const sent = await bot.sendSticker(
    chatId,
    buffer,
    {},
    {
      filename,
      contentType
    }
  );

  sessions.set(String(userId), {
    buffer,
    format,
    filename,
    contentType,
    fileId: sent.sticker.file_id
  });

  await bot.sendMessage(
    chatId,
    "استیکرت آماده شد! ✨",
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📦 ساخت پک جدید",
              callback_data: "newpack"
            }
          ],
          [
            {
              text: "➕ افزودن به پک",
              callback_data: "addpack"
            }
          ]
        ]
      }
    }
  );
}

// پردازش عکس
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

    await sendSticker(
      chatId,
      msg.from.id,
      sticker,
      "static"
    );
  } catch (error) {
    logError("PHOTO ERROR", error);

    await bot.sendMessage(
      chatId,
      `ساخت استیکر عکس ناموفق بود.\n${describeError(error).slice(0, 800)}`
    );
  }
}

// پردازش فیلم
async function processVideo(msg, fileId) {
  const chatId = msg.chat.id;

  try {
    await bot.sendMessage(
      chatId,
      "دارم فریم‌های فیلم رو پردازش می‌کنم؛ لطفاً صبر کن... 🌙"
    );

    const input = await downloadFile(fileId);
    const sticker = await makeVideoSticker(input);

    await sendSticker(
      chatId,
      msg.from.id,
      sticker,
      "video"
    );
  } catch (error) {
    logError("VIDEO ERROR", error);

    await bot.sendMessage(
      chatId,
      `ساخت استیکر فیلم ناموفق بود.\n${describeError(error).slice(0, 800)}`
    );
  }
}

// ساخت نام مناسب برای پک
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

// ارسال درخواست چندبخشی به Telegram Bot API
async function telegramMultipart(
  method,
  fields,
  buffer,
  filename,
  contentType
) {
  const form = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    form.append(
      key,
      typeof value === "string"
        ? value
        : JSON.stringify(value)
    );
  }

  form.append("sticker_file", buffer, {
    filename,
    contentType
  });

  let response;

  try {
    response = await axios.post(
      `https://api.telegram.org/bot${TOKEN}/${method}`,
      form,
      {
        headers: form.getHeaders(),
        timeout: 120000,
        maxBodyLength: Infinity
      }
    );
  } catch (error) {
    logError(`TELEGRAM ${method} ERROR`, error);
    throw new Error(describeError(error));
  }

  if (!response.data.ok) {
    throw new Error(
      response.data.description || "درخواست تلگرام ناموفق بود."
    );
  }

  return response.data.result;
}

// ساخت پک جدید با استیکر فعلی
async function createPack(userId, title, chatId) {
  const session = sessions.get(String(userId));

  if (!session) {
    return bot.sendMessage(
      chatId,
      "اول یک عکس یا فیلم بفرست و استیکر بساز."
    );
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
        stickers: [
          {
            sticker: "attach://sticker_file",
            format: session.format,
            emoji_list: ["✨"]
          }
        ]
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
    logError("CREATE PACK ERROR", error);

    await bot.sendMessage(
      chatId,
      `ساخت پک ناموفق بود:\n${describeError(error).slice(0, 800)}`
    );
  }
}

// اضافه کردن استیکر به پک موجود
async function addToPack(userId, packName, chatId) {
  const session = sessions.get(String(userId));

  if (!session) {
    return bot.sendMessage(
      chatId,
      "اول یک استیکر بساز."
    );
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

    await bot.sendMessage(
      chatId,
      "استیکر به پک اضافه شد! ✨"
    );
  } catch (error) {
    logError("ADD PACK ERROR", error);

    await bot.sendMessage(
      chatId,
      `افزودن استیکر ناموفق بود:\n${describeError(error).slice(0, 800)}`
    );
  }
}

bot.onText(/^\/start$/, async msg => {
  await bot.sendMessage(
    msg.chat.id,
    "سلام! 🍄\n\n" +
    "عکس یا فیلم کوتاه بفرست تا پس‌زمینه‌ش رو حذف کنم " +
    "و به استیکر شفاف تبدیلش کنم.\n\n" +
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
      "اسم پک رو بفرست؛ بهتره انگلیسی و کوتاه باشه."
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

    return bot.sendMessage(
      chatId,
      "کدوم پک؟",
      {
        reply_markup: {
          inline_keyboard: packs.map((pack, index) => [
            {
              text: pack.title,
              callback_data: `pack:${index}`
            }
          ])
        }
      }
    );
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
    const match = input.match(
      /(?:addstickers\/)?([A-Za-z0-9_]+_by_[A-Za-z0-9_]+)/
    );

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
