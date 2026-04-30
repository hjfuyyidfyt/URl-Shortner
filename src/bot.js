import "dotenv/config";
import { Telegraf } from "telegraf";
import { nanoid } from "nanoid";
import {
  addPromoChannel,
  deleteVideoById,
  getRemainingMinutes,
  getVideoByCode,
  incrementViews,
  initDb,
  isVideoExpired,
  listAllPromoChannels,
  listExpiredVideos,
  listPromoChannels,
  removePromoChannel,
  saveVideo,
  togglePromoChannel
} from "./db.js";

const {
  BOT_TOKEN,
  STORAGE_CHANNEL_ID,
  CODE_LENGTH = "10",
  ADMIN_IDS = ""
} = process.env;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!STORAGE_CHANNEL_ID) throw new Error("STORAGE_CHANNEL_ID is required");

const bot = new Telegraf(BOT_TOKEN);
let botUsername;
const adminIds = ADMIN_IDS.split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const pendingChannelUsers = new Map();
const pendingVideoUploads = new Map();

function makeCode() {
  return `v_${nanoid(Number(CODE_LENGTH))}`;
}

function getIncomingVideo(message) {
  if (message.video) {
    return {
      fileId: message.video.file_id,
      fileUniqueId: message.video.file_unique_id,
      mimeType: message.video.mime_type ?? "video/mp4",
      fileName: message.video.file_name ?? null
    };
  }

  if (message.document?.mime_type?.startsWith("video/")) {
    return {
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id,
      mimeType: message.document.mime_type,
      fileName: message.document.file_name ?? null
    };
  }

  return null;
}

function shareUrl(code) {
  return `https://t.me/${botUsername}?start=${encodeURIComponent(code)}`;
}

function isChatNotFound(error) {
  return error?.response?.error_code === 400
    && error?.response?.description?.toLowerCase().includes("chat not found");
}

function isAdmin(userId) {
  return adminIds.length === 0 || adminIds.includes(String(userId));
}

function normalizeTelegramUrl(rawText) {
  const text = rawText.trim();

  if (/^https:\/\/t\.me\/[a-zA-Z0-9_+/=-]+$/u.test(text)) return text;
  if (/^t\.me\/[a-zA-Z0-9_+/=-]+$/u.test(text)) return `https://${text}`;
  if (/^@[a-zA-Z0-9_]{5,32}$/u.test(text)) return `https://t.me/${text.slice(1)}`;
  if (/^[a-zA-Z0-9_]{5,32}$/u.test(text)) return `https://t.me/${text}`;

  return null;
}

function getChannelFallbackName(url) {
  return url.replace("https://t.me/", "@");
}

function parseDeleteMinutes(text) {
  const minutes = Number(text.trim());

  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 43200) {
    return null;
  }

  return minutes;
}

async function savePromoChannel(ctx, url, rawName) {
  const name = rawName.trim().slice(0, 64) || getChannelFallbackName(url);

  await addPromoChannel(url, name, ctx.from.id);
  await ctx.reply(`✅ Channel added:\n${name}\n${url}`);
}

function buildPromoPanel(channels) {
  if (channels.length === 0) {
    return {
      text: "📢 No promo channels added yet.\n\nSend a channel username or URL to add one.",
      keyboard: []
    };
  }

  const keyboard = channels.flatMap((channel) => {
    const name = channel.name || getChannelFallbackName(channel.url);
    const status = channel.is_active ? "✅" : "⛔";

    return [
      [{ text: `${status} ${name}`, callback_data: `promo:toggle:${channel.id}` }],
      [
        { text: "🔗 Open", url: channel.url },
        { text: "🗑 Remove", callback_data: `promo:remove:${channel.id}` }
      ]
    ];
  });

  return {
    text: "📢 Promo Channels\n\nTap a channel to turn it on/off, or remove it.",
    keyboard
  };
}

async function sendPromoPanel(ctx, mode = "reply") {
  const channels = await listAllPromoChannels();
  const panel = buildPromoPanel(channels);
  const options = { reply_markup: { inline_keyboard: panel.keyboard } };

  if (mode === "edit") {
    await ctx.editMessageText(panel.text, options);
    return;
  }

  await ctx.reply(panel.text, options);
}

async function sendPromoChannels(ctx) {
  const channels = await listPromoChannels();
  if (channels.length === 0) return;

  const buttons = channels.map((channel) => ([{
    text: channel.name || getChannelFallbackName(channel.url),
    url: channel.url
  }]));

  await ctx.reply(
    [
      "🎬 You can see more videos like this:",
      "🇧🇩 আপনি এমন আরও ভিডিও দেখতে পারেন:",
      "🇷🇺 Вы можете посмотреть больше таких видео:",
      "🇮🇳 आप इस तरह के और वीडियो देख सकते हैं:"
    ].join("\n"),
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

bot.start(async (ctx) => {
  const payload = ctx.startPayload;

  if (!payload) {
    await ctx.reply("Send me a video and I will create a share link automatically.");
    return;
  }

  const video = await getVideoByCode(payload);
  if (!video) {
    await ctx.reply("This video link is invalid or no longer available.");
    return;
  }

  if (isVideoExpired(video)) {
    await ctx.reply("This video has been deleted.");
    try {
      await ctx.telegram.deleteMessage(
        video.storage_chat_id,
        Number(video.storage_message_id)
      );
    } catch (error) {
      console.error("Expired video deleteMessage failed", {
        videoId: video.id,
        error
      });
    }
    await deleteVideoById(video.id);
    return;
  }

  await ctx.telegram.copyMessage(
    ctx.chat.id,
    video.storage_chat_id,
    Number(video.storage_message_id)
  );
  await ctx.reply(`This video will delete after ${getRemainingMinutes(video)} minutes.`);
  await sendPromoChannels(ctx);
  await incrementViews(payload);
});

bot.command("id", async (ctx) => {
  await ctx.reply(`Your Telegram user ID: ${ctx.from.id}`);
});

bot.command("cha", async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("You are not allowed to manage promo channels.");
    return;
  }

  await sendPromoPanel(ctx);
});

bot.action(/^promo:(toggle|remove):(\d+)$/u, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery("Not allowed");
    return;
  }

  const [, action, id] = ctx.match;

  if (action === "toggle") {
    await togglePromoChannel(id);
    await ctx.answerCbQuery("Updated");
  } else {
    await removePromoChannel(id);
    await ctx.answerCbQuery("Removed");
  }

  await sendPromoPanel(ctx, "edit");
});

bot.command("channelcheck", async (ctx) => {
  try {
    const chat = await ctx.telegram.getChat(STORAGE_CHANNEL_ID);
    const title = chat.title ?? chat.username ?? STORAGE_CHANNEL_ID;
    await ctx.reply(`Storage channel OK: ${title}`);
  } catch (error) {
    if (isChatNotFound(error)) {
      await ctx.reply(
        "Storage channel not found. Add this bot as admin in the private channel and check STORAGE_CHANNEL_ID."
      );
      return;
    }

    throw error;
  }
});

bot.on("message", async (ctx) => {
  const pendingVideo = pendingVideoUploads.get(ctx.from.id);

  if (pendingVideo) {
    if (!ctx.message.text) {
      await ctx.reply("Please send the delete time in minutes.");
      return;
    }

    const deleteAfterMinutes = parseDeleteMinutes(ctx.message.text);

    if (!deleteAfterMinutes) {
      await ctx.reply("Please send a valid number from 1 to 43200 minutes.");
      return;
    }

    await saveVideo({
      ...pendingVideo,
      deleteAfterMinutes
    });

    pendingVideoUploads.delete(ctx.from.id);
    await ctx.reply(`Upload complete.\n\nThis video will delete after ${deleteAfterMinutes} minutes.\n\nShare link:\n${shareUrl(pendingVideo.code)}`);
    return;
  }

  const pendingChannel = pendingChannelUsers.get(ctx.from.id);

  if (pendingChannel) {
    if (!isAdmin(ctx.from.id)) {
      pendingChannelUsers.delete(ctx.from.id);
      await ctx.reply("You are not allowed to add promo channels.");
      return;
    }

    if (!ctx.message.text) {
      await ctx.reply("Please send the button name as text.");
      return;
    }

    await savePromoChannel(ctx, pendingChannel.url, ctx.message.text);
    pendingChannelUsers.delete(ctx.from.id);
    return;
  }

  if (ctx.message.text && isAdmin(ctx.from.id)) {
    const url = normalizeTelegramUrl(ctx.message.text);

    if (url) {
      pendingChannelUsers.set(ctx.from.id, { url });
      await ctx.reply("🏷️ Send the button name for this channel.");
      return;
    }
  }

  const incomingVideo = getIncomingVideo(ctx.message);

  if (!incomingVideo) {
    await ctx.reply("Please send a video file.");
    return;
  }

  const code = makeCode();
  let copied;

  try {
    copied = await ctx.telegram.copyMessage(
      STORAGE_CHANNEL_ID,
      ctx.chat.id,
      ctx.message.message_id
    );
  } catch (error) {
    if (isChatNotFound(error)) {
      await ctx.reply(
        "Upload failed: storage channel not found. Add this bot as admin in the private channel and check STORAGE_CHANNEL_ID."
      );
      return;
    }

    throw error;
  }

  pendingVideoUploads.set(ctx.from.id, {
    code,
    uploaderId: ctx.from.id,
    uploaderUsername: ctx.from.username ?? null,
    sourceChatId: ctx.chat.id,
    sourceMessageId: ctx.message.message_id,
    storageChatId: STORAGE_CHANNEL_ID,
    storageMessageId: copied.message_id,
    telegramFileId: incomingVideo.fileId,
    telegramFileUniqueId: incomingVideo.fileUniqueId,
    mimeType: incomingVideo.mimeType,
    fileName: incomingVideo.fileName,
    caption: ctx.message.caption ?? null
  });

  await ctx.reply("How many minutes after upload should this video be deleted? Send a number, like 30.");
});

bot.catch((error, ctx) => {
  console.error("Bot error", {
    updateId: ctx.update?.update_id,
    error
  });
});

await initDb();
const me = await bot.telegram.getMe();
botUsername = me.username;
await bot.launch();

console.log(`Bot is running as @${botUsername}`);

async function cleanupExpiredVideos() {
  const expiredVideos = await listExpiredVideos();

  for (const video of expiredVideos) {
    try {
      await bot.telegram.deleteMessage(
        video.storage_chat_id,
        Number(video.storage_message_id)
      );
    } catch (error) {
      console.error("Expired video cleanup deleteMessage failed", {
        videoId: video.id,
        error
      });
    }

    await deleteVideoById(video.id);
  }
}

setInterval(() => {
  cleanupExpiredVideos().catch((error) => {
    console.error("Expired video cleanup failed", error);
  });
}, 60000);

cleanupExpiredVideos().catch((error) => {
  console.error("Expired video cleanup failed", error);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
