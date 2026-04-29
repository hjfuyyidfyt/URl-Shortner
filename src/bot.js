import "dotenv/config";
import { Telegraf } from "telegraf";
import { nanoid } from "nanoid";
import { getVideoByCode, incrementViews, initDb, saveVideo } from "./db.js";

const {
  BOT_TOKEN,
  STORAGE_CHANNEL_ID,
  CODE_LENGTH = "10"
} = process.env;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!STORAGE_CHANNEL_ID) throw new Error("STORAGE_CHANNEL_ID is required");

const bot = new Telegraf(BOT_TOKEN);
let botUsername;

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
  await incrementViews(payload);
});

bot.on("message", async (ctx) => {
  const incomingVideo = getIncomingVideo(ctx.message);

  if (!incomingVideo) {
    await ctx.reply("Please send a video file.");
    return;
  }

  const code = makeCode();
  const copied = await ctx.telegram.copyMessage(
    STORAGE_CHANNEL_ID,
    ctx.chat.id,
    ctx.message.message_id
  );

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
