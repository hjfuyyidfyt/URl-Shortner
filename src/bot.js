import "dotenv/config";
import { Telegraf } from "telegraf";
import { nanoid } from "nanoid";
import {
  addPromoChannel,
  getVideoByCode,
  incrementViews,
  initDb,
  listPromoChannels,
  saveVideo
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

function normalizeTelegramUrl(rawUrl) {
  const url = rawUrl.trim();

  if (/^https:\/\/t\.me\/[a-zA-Z0-9_+/=-]+$/u.test(url)) return url;
  if (/^t\.me\/[a-zA-Z0-9_+/=-]+$/u.test(url)) return `https://${url}`;
  if (/^@[a-zA-Z0-9_]{5,32}$/u.test(url)) return `https://t.me/${url.slice(1)}`;
  if (/^[a-zA-Z0-9_]{5,32}$/u.test(url)) return `https://t.me/${url}`;

  return null;
}

function getChannelFallbackName(url) {
  return url.replace("https://t.me/", "@");
}

async function prepareChannelFromText(ctx, rawChannel) {
  const url = normalizeTelegramUrl(rawChannel);

  if (!url) {
    await ctx.reply("Please send a valid channel, like t.me/channelname, @channelname, or channelname.");
    return null;
  }

  return url;
}

async function savePromoChannel(ctx, url, rawName) {
  const name = rawName.trim().slice(0, 64) || getChannelFallbackName(url);

  await addPromoChannel(url, name, ctx.from.id);
  await ctx.reply(`✅ Channel added:\n${name}\n${url}`);
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

  await ctx.telegram.copyMessage(
    ctx.chat.id,
    video.storage_chat_id,
    Number(video.storage_message_id)
  );
  await sendPromoChannels(ctx);
  await incrementViews(payload);
});

bot.command("id", async (ctx) => {
  await ctx.reply(`Your Telegram user ID: ${ctx.from.id}`);
});

bot.command("cha", async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("You are not allowed to add promo channels.");
    return;
  }

  const rawChannel = ctx.message.text.replace(/^\/cha(@\w+)?\s*/u, "").trim();

  if (!rawChannel) {
    pendingChannelUsers.set(ctx.from.id, { step: "channel" });
    await ctx.reply("🔗 Send a channel: t.me/channelname, @channelname, or channelname");
    return;
  }

  const url = await prepareChannelFromText(ctx, rawChannel);
  if (!url) return;

  pendingChannelUsers.set(ctx.from.id, { step: "name", url });
  await ctx.reply("🏷️ Now send the button name for this channel.");
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
  const pendingChannel = pendingChannelUsers.get(ctx.from.id);

  if (pendingChannel) {
    if (!isAdmin(ctx.from.id)) {
      pendingChannelUsers.delete(ctx.from.id);
      await ctx.reply("You are not allowed to add promo channels.");
      return;
    }

    if (!ctx.message.text) {
      await ctx.reply("Please send text only.");
      return;
    }

    if (pendingChannel.step === "channel") {
      const url = await prepareChannelFromText(ctx, ctx.message.text);
      if (!url) return;

      pendingChannelUsers.set(ctx.from.id, { step: "name", url });
      await ctx.reply("🏷️ Now send the button name for this channel.");
      return;
    }

    await savePromoChannel(ctx, pendingChannel.url, ctx.message.text);
    pendingChannelUsers.delete(ctx.from.id);
    return;
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

  await saveVideo({
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

  await ctx.reply(`Upload complete.\n\nShare link:\n${shareUrl(code)}`);
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

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
