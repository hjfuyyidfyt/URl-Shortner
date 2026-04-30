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
      delete_after_minutes integer,
      expires_at timestamptz,
      views bigint not null default 0,
      created_at timestamptz not null default now()
    );

    alter table videos add column if not exists delete_after_minutes integer;
    alter table videos add column if not exists expires_at timestamptz;

    create index if not exists videos_uploader_id_idx on videos (uploader_id);
    create index if not exists videos_created_at_idx on videos (created_at desc);
    create index if not exists videos_expires_at_idx on videos (expires_at);

    create table if not exists promo_channels (
      id bigserial primary key,
      name text,
      url text not null unique,
      added_by bigint not null,
      is_active boolean not null default true,
      created_at timestamptz not null default now()
    );

    alter table promo_channels add column if not exists name text;
    alter table promo_channels add column if not exists is_active boolean not null default true;

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
        caption,
        delete_after_minutes,
        expires_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() + ($13 * interval '1 minute'))
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
      video.caption,
      video.deleteAfterMinutes
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

export function isVideoExpired(video) {
  return video?.expires_at && new Date(video.expires_at).getTime() <= Date.now();
}

export function getRemainingMinutes(video) {
  if (!video?.expires_at) return null;

  const remainingMs = new Date(video.expires_at).getTime() - Date.now();
  return Math.max(1, Math.ceil(remainingMs / 60000));
}

export async function listExpiredVideos(limit = 50) {
  const result = await pool.query(
    `
      select id, storage_chat_id, storage_message_id
      from videos
      where expires_at is not null and expires_at <= now()
      order by expires_at asc
      limit $1
    `,
    [limit]
  );

  return result.rows;
}

export async function deleteVideoById(id) {
  await pool.query("delete from videos where id = $1", [id]);
}

export async function addPromoChannel(url, name, addedBy) {
  const result = await pool.query(
    `
      insert into promo_channels (url, name, added_by)
      values ($1, $2, $3)
      on conflict (url) do update set
        name = excluded.name,
        is_active = true
      returning *
    `,
    [url, name, addedBy]
  );

  return result.rows[0];
}

export async function listPromoChannels() {
  const result = await pool.query(
    "select id, url, name, is_active from promo_channels where is_active = true order by created_at asc"
  );

  return result.rows;
}

export async function listAllPromoChannels() {
  const result = await pool.query(
    "select id, url, name, is_active from promo_channels order by created_at asc"
  );

  return result.rows;
}

export async function togglePromoChannel(id) {
  const result = await pool.query(
    `
      update promo_channels
      set is_active = not is_active
      where id = $1
      returning *
    `,
    [id]
  );

  return result.rows[0] ?? null;
}

export async function removePromoChannel(id) {
  await pool.query("delete from promo_channels where id = $1", [id]);
}
