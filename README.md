# Telegram Video Share Bot

Automatic Telegram video sharing bot:

1. User sends any video to the bot.
2. Bot copies it into a private storage channel.
3. Bot asks how many minutes later the video should be deleted.
4. Bot stores a unique code and expiry time in PostgreSQL.
5. Bot replies with a share URL like `https://t.me/YourBotUsername?start=v_abc123`.
6. Anyone opening the link is taken to the bot and receives the video until it expires.

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Fill `.env`:

- `BOT_TOKEN`: BotFather token.
- `DATABASE_URL`: PostgreSQL URL.
- `STORAGE_CHANNEL_ID`: private channel numeric ID, usually starts with `-100`.
- `ADMIN_IDS`: optional comma-separated Telegram user IDs allowed to add promo channels.

Add the bot as admin in the private storage channel, then run:

```powershell
npm start
```

## Railway

Push this project to GitHub, create a Railway project from the repo, then add these variables in Railway:

- `BOT_TOKEN`
- `DATABASE_URL`
- `STORAGE_CHANNEL_ID`
- `CODE_LENGTH` optional
- `ADMIN_IDS` optional

Railway can run it with the existing `npm start` script.

## Notes

- `/upload` is not required. Sending a video automatically creates a share link.
- Each upload has its own delete time in minutes.
- Bot username is detected automatically from `BOT_TOKEN`.
- Add promo channels by sending `t.me/channelname`, `@channelname`, or `channelname`, then send the button name. Use `/cha` to manage promo channels and turn them on/off or remove them.
- Telegram deep links cannot open the video directly before the user starts the bot. The link opens the bot, then the bot sends the video.
- If a database URL or bot token was shared publicly, rotate it before deployment.
