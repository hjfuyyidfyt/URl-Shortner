import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  enableChannelBinding: true
});

export async function initDb() {
  await pool.query(`
    create table if not exists videos (
      id bigserial primary key,
      code text not null unique,
      uploader_id bigint not null,
      uploader_username text,
      source_chat_id bigint not null,
      source_message_id bigint not null,
      storage_chat_id text not null,
      storage_message_id bigint not null,
      telegram_file_id text,
      telegram_file_unique_id text,
      mime_type text,
      file_name text,
      caption text,
      views bigint not null default 0,
      created_at timestamptz not null default now()
    );

    create index if not exists videos_uploader_id_idx on videos (uploader_id);
    create index if not exists videos_created_at_idx on videos (created_at desc);

    create table if not exists promo_channels (
      id bigserial primary key,
      url text not null unique,
      added_by bigint not null,
      is_active boolean not null default true,
      created_at timestamptz not null default now()
    );

    create index if not exists promo_channels_active_idx on promo_channels (is_active, created_at);
  `);
}

export async function saveVideo(video) {
  const result = await pool.query(
    `
      insert into videos (
        code,
        uploader_id,
        uploader_username,
        source_chat_id,
        source_message_id,
        storage_chat_id,
        storage_message_id,
        telegram_file_id,
        telegram_file_unique_id,
        mime_type,
        file_name,
        caption
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      returning *
    `,
    [
      video.code,
      video.uploaderId,
      video.uploaderUsername,
      video.sourceChatId,
      video.sourceMessageId,
      video.storageChatId,
      video.storageMessageId,
      video.telegramFileId,
      video.telegramFileUniqueId,
      video.mimeType,
      video.fileName,
      video.caption
    ]
  );

  return result.rows[0];
}

export async function getVideoByCode(code) {
  const result = await pool.query(
    "select * from videos where code = $1 limit 1",
    [code]
  );

  return result.rows[0] ?? null;
}

export async function incrementViews(code) {
  await pool.query("update videos set views = views + 1 where code = $1", [code]);
}

export async function addPromoChannel(url, addedBy) {
  const result = await pool.query(
    `
      insert into promo_channels (url, added_by)
      values ($1, $2)
      on conflict (url) do update set is_active = true
      returning *
    `,
    [url, addedBy]
  );

  return result.rows[0];
}

export async function listPromoChannels() {
  const result = await pool.query(
    "select url from promo_channels where is_active = true order by created_at asc"
  );

  return result.rows;
}
