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
      views bigint not null default 0,
      created_at timestamptz not null default now()
    );

    alter table videos add column if not exists delete_after_minutes integer;

    create index if not exists videos_uploader_id_idx on videos (uploader_id);
    create index if not exists videos_created_at_idx on videos (created_at desc);

    create table if not exists video_deliveries (
      id bigserial primary key,
      video_id bigint references videos(id) on delete cascade,
      recipient_user_id bigint,
      recipient_username text,
      recipient_first_name text,
      recipient_chat_id bigint not null,
      recipient_message_id bigint not null,
      delete_at timestamptz not null,
      deleted_at timestamptz,
      created_at timestamptz not null default now()
    );

    alter table video_deliveries add column if not exists recipient_user_id bigint;
    alter table video_deliveries add column if not exists recipient_username text;
    alter table video_deliveries add column if not exists recipient_first_name text;
    alter table video_deliveries add column if not exists deleted_at timestamptz;

    update video_deliveries
    set recipient_user_id = recipient_chat_id
    where recipient_user_id is null;

    create index if not exists video_deliveries_delete_at_idx on video_deliveries (delete_at);
    create index if not exists video_deliveries_recipient_user_idx on video_deliveries (recipient_user_id);

    create table if not exists stats_excluded_users (
      user_id bigint primary key,
      username text,
      first_name text,
      added_by bigint not null,
      created_at timestamptz not null default now()
    );

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
        delete_after_minutes
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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

export async function saveVideoDelivery(videoId, recipient, recipientChatId, recipientMessageId, deleteAfterMinutes) {
  const result = await pool.query(
    `
      insert into video_deliveries (
        video_id,
        recipient_user_id,
        recipient_username,
        recipient_first_name,
        recipient_chat_id,
        recipient_message_id,
        delete_at
      )
      values ($1, $2, $3, $4, $5, $6, now() + ($7 * interval '1 minute'))
      returning *
    `,
    [
      videoId,
      recipient.id,
      recipient.username ?? null,
      recipient.first_name ?? null,
      recipientChatId,
      recipientMessageId,
      deleteAfterMinutes
    ]
  );

  return result.rows[0];
}

export async function listDueVideoDeliveries(limit = 50) {
  const result = await pool.query(
    `
      select id, recipient_chat_id, recipient_message_id
      from video_deliveries
      where delete_at <= now() and deleted_at is null
      order by delete_at asc
      limit $1
    `,
    [limit]
  );

  return result.rows;
}

export async function markVideoDeliveryDeleted(id) {
  await pool.query(
    "update video_deliveries set deleted_at = coalesce(deleted_at, now()) where id = $1",
    [id]
  );
}

export async function getStats() {
  const result = await pool.query(`
    with counted_deliveries as (
      select d.*
      from video_deliveries d
      left join stats_excluded_users e on e.user_id = d.recipient_user_id
      where e.user_id is null
    ),
    totals as (
      select
        (select count(*) from videos)::bigint as total_uploaded,
        count(*)::bigint as total_serves,
        count(distinct (coalesce(recipient_user_id, recipient_chat_id)::text || ':' || video_id::text))::bigint as unique_user_video_serves,
        count(distinct coalesce(recipient_user_id, recipient_chat_id))::bigint as total_viewers
      from counted_deliveries
    )
    select
      total_uploaded,
      total_serves,
      unique_user_video_serves,
      greatest(total_serves - unique_user_video_serves, 0)::bigint as repeat_serves,
      total_viewers
    from totals
  `);

  return result.rows[0];
}

export async function getTopViewers(limit = 10) {
  const result = await pool.query(
    `
      with counted_deliveries as (
        select d.*
        from video_deliveries d
        left join stats_excluded_users e on e.user_id = d.recipient_user_id
        where e.user_id is null
      )
      select
        coalesce(recipient_user_id, recipient_chat_id) as user_id,
        max(recipient_username) as username,
        max(recipient_first_name) as first_name,
        count(distinct video_id)::bigint as unique_videos,
        count(*)::bigint as total_serves
      from counted_deliveries
      group by coalesce(recipient_user_id, recipient_chat_id)
      order by unique_videos desc, total_serves desc
      limit $1
    `,
    [limit]
  );

  return result.rows;
}

export async function getTopVideos(limit = 5) {
  const result = await pool.query(
    `
      with counted_deliveries as (
        select d.*
        from video_deliveries d
        left join stats_excluded_users e on e.user_id = d.recipient_user_id
        where e.user_id is null
      )
      select
        v.code,
        count(*)::bigint as total_serves,
        count(distinct coalesce(d.recipient_user_id, d.recipient_chat_id))::bigint as unique_viewers
      from counted_deliveries d
      join videos v on v.id = d.video_id
      group by v.code
      order by total_serves desc, unique_viewers desc
      limit $1
    `,
    [limit]
  );

  return result.rows;
}

export async function addStatsExcludedUser(userId, addedBy, username = null, firstName = null) {
  const result = await pool.query(
    `
      insert into stats_excluded_users (user_id, username, first_name, added_by)
      values ($1, $2, $3, $4)
      on conflict (user_id) do update set
        username = coalesce(excluded.username, stats_excluded_users.username),
        first_name = coalesce(excluded.first_name, stats_excluded_users.first_name)
      returning *
    `,
    [userId, username, firstName, addedBy]
  );

  return result.rows[0];
}

export async function listStatsExcludedUsers() {
  const result = await pool.query(
    "select user_id, username, first_name, created_at from stats_excluded_users order by created_at asc"
  );

  return result.rows;
}

export async function removeStatsExcludedUser(userId) {
  await pool.query("delete from stats_excluded_users where user_id = $1", [userId]);
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
