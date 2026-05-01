import "dotenv/config";
import { Telegraf } from "telegraf";
import { nanoid } from "nanoid";
import {
  addPromoChannel,
  addStatsExcludedUser,
  getStats,
  getTopVideos,
  getTopViewers,
  getVideoByCode,
  incrementViews,
  initDb,
  listAllPromoChannels,
  listDueVideoDeliveries,
  listPromoChannels,
  listStatsExcludedUsers,
  markVideoDeliveryDeleted,
  removePromoChannel,
  removeStatsExcludedUser,
  saveVideo,
  saveVideoDelivery,
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
const pendingStatsExcludeUsers = new Set();

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

function getDeleteAfterMinutes(video) {
  const minutes = Number(video.delete_after_minutes);

  if (Number.isInteger(minutes) && minutes > 0) {
    return minutes;
  }

  return 30;
}

async function deleteDeliveredVideo(delivery) {
  try {
    await bot.telegram.deleteMessage(
      delivery.recipient_chat_id,
      Number(delivery.recipient_message_id)
    );
  } catch (error) {
    console.error("Delivery deleteMessage failed", {
      deliveryId: delivery.id,
      chatId: delivery.recipient_chat_id,
      messageId: delivery.recipient_message_id,
      error
    });
  }

  await markVideoDeliveryDeleted(delivery.id);
}

function scheduleDeliveryDeletion(delivery) {
  const deleteAt = new Date(delivery.delete_at).getTime();
  const delay = Math.max(1000, deleteAt - Date.now());
  const maxDelay = 2147483647;

  setTimeout(() => {
    deleteDeliveredVideo(delivery).catch((error) => {
      console.error("Scheduled delivery cleanup failed", {
        deliveryId: delivery.id,
        error
      });
    });
  }, Math.min(delay, maxDelay));
}

async function savePromoChannel(ctx, url, rawName) {
  const name = rawName.trim().slice(0, 64) || getChannelFallbackName(url);

  await addPromoChannel(url, name, ctx.from.id);
  await ctx.reply(`✅ Channel added:\n${name}\n${url}`);
}

function formatUserLabel(user) {
  if (user.username) return `@${user.username}`;
  if (user.first_name) return user.first_name;
  return String(user.user_id);
}

function parseUserId(text) {
  const userId = text.trim();

  if (!/^\d{4,20}$/u.test(userId)) {
    return null;
  }

  return userId;
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

function buildStatsExcludePanel(users) {
  if (users.length === 0) {
    return {
      text: "🚫 Stats Excluded Users\n\nNo users excluded yet.\n\nSend a Telegram user ID to exclude.",
      keyboard: []
    };
  }

  const lines = users.map((user, index) => (
    `${index + 1}. ${formatUserLabel(user)} - ${user.user_id}`
  ));
  const keyboard = users.map((user) => ([{
    text: `Remove ${formatUserLabel(user)}`,
    callback_data: `unsmt:remove:${user.user_id}`
  }]));

  return {
    text: ["🚫 Stats Excluded Users", "", ...lines, "", "Send a Telegram user ID to exclude."].join("\n"),
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

async function sendStatsExcludePanel(ctx, mode = "reply") {
  const users = await listStatsExcludedUsers();
  const panel = buildStatsExcludePanel(users);
  const options = { reply_markup: { inline_keyboard: panel.keyboard } };

  if (mode === "edit") {
    await ctx.editMessageText(panel.text, options);
    return;
  }

  await ctx.reply(panel.text, options);
}

async function addStatsExcludeFromText(ctx, text) {
  const userId = parseUserId(text);

  if (!userId) {
    await ctx.reply("Please send a valid Telegram user ID. Use /id from that account to get it.");
    return false;
  }

  await addStatsExcludedUser(userId, ctx.from.id);
  await ctx.reply(`User excluded from stats:\n${userId}`);
  return true;
}

function formatNumber(value) {
  return Number(value ?? 0).toLocaleString("en-US");
}

async function sendStats(ctx) {
  const [stats, topViewers, topVideos] = await Promise.all([
    getStats(),
    getTopViewers(10),
    getTopVideos(5)
  ]);

  const viewerLines = topViewers.length === 0
    ? ["No viewer data yet."]
    : topViewers.map((viewer, index) => (
      `${index + 1}. ${formatUserLabel(viewer)} - ${formatNumber(viewer.unique_videos)} videos (${formatNumber(viewer.total_serves)} serves)`
    ));

  const videoLines = topVideos.length === 0
    ? ["No video data yet."]
    : topVideos.map((video, index) => (
      `${index + 1}. ${video.code} - ${formatNumber(video.total_serves)} serves / ${formatNumber(video.unique_viewers)} viewers`
    ));

  await ctx.reply([
    "📊 Bot Stats",
    "",
    `Total videos uploaded: ${formatNumber(stats.total_uploaded)}`,
    `Total video serves: ${formatNumber(stats.total_serves)}`,
    `Unique user-video serves: ${formatNumber(stats.unique_user_video_serves)}`,
    `Repeat serves: ${formatNumber(stats.repeat_serves)}`,
    `Total viewers: ${formatNumber(stats.total_viewers)}`,
    "",
    "👥 Top viewers",
    ...viewerLines,
    "",
    "🎬 Top videos",
    ...videoLines
  ].join("\n"));
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

  const delivered = await ctx.telegram.copyMessage(
    ctx.chat.id,
    video.storage_chat_id,
    Number(video.storage_message_id)
  );
  const deleteAfterMinutes = getDeleteAfterMinutes(video);

  const delivery = await saveVideoDelivery(
    video.id,
    ctx.from,
    ctx.chat.id,
    delivered.message_id,
    deleteAfterMinutes
  );
  scheduleDeliveryDeletion(delivery);
  await ctx.reply(`This video will delete after ${deleteAfterMinutes} minutes.`);
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

bot.command("smt", async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("You are not allowed to view stats.");
    return;
  }

  await sendStats(ctx);
});

bot.command("unsmt", async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("You are not allowed to manage stats exclusions.");
    return;
  }

  const userId = ctx.message.text.replace(/^\/unsmt(@\w+)?\s*/u, "").trim();

  if (userId) {
    await addStatsExcludeFromText(ctx, userId);
    return;
  }

  pendingStatsExcludeUsers.add(ctx.from.id);
  await sendStatsExcludePanel(ctx);
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

bot.action(/^unsmt:remove:(\d+)$/u, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery("Not allowed");
    return;
  }

  const [, userId] = ctx.match;

  await removeStatsExcludedUser(userId);
  await ctx.answerCbQuery("Removed");
  await sendStatsExcludePanel(ctx, "edit");
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
  if (pendingStatsExcludeUsers.has(ctx.from.id)) {
    if (!isAdmin(ctx.from.id)) {
      pendingStatsExcludeUsers.delete(ctx.from.id);
      await ctx.reply("You are not allowed to manage stats exclusions.");
      return;
    }

    if (!ctx.message.text) {
      await ctx.reply("Please send the Telegram user ID as text.");
      return;
    }

    const added = await addStatsExcludeFromText(ctx, ctx.message.text);
    if (added) pendingStatsExcludeUsers.delete(ctx.from.id);
    return;
  }

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

async function cleanupDueVideoDeliveries() {
  const dueDeliveries = await listDueVideoDeliveries();

  for (const delivery of dueDeliveries) {
    await deleteDeliveredVideo(delivery);
  }
}

setInterval(() => {
  cleanupDueVideoDeliveries().catch((error) => {
    console.error("Delivery cleanup failed", error);
  });
}, 15000);

cleanupDueVideoDeliveries().catch((error) => {
  console.error("Delivery cleanup failed", error);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
