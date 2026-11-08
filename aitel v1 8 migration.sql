-- =====================================================================
-- AITEL v1.8 — Supabase migration (قابل اجرای مجدد / idempotent)
-- اجرا در: Supabase Dashboard → SQL Editor
--
-- پیش از اجرا بررسی کنید که کسی username=aitel_bot را نگرفته باشد:
--   select id, username from public.aitel_profiles where lower(username)='aitel_bot';
-- اگر نتیجه‌ای آمد، آن کاربر را تغییر نام دهید، وگرنه ساخت ربات خطا می‌دهد.
--
-- فرض‌ها درباره‌ی ساختار فعلی (از روی کد v1.7):
--   aitel_chats(id, chat_type, created_by, title, updated_at ...)
--   aitel_chat_members(chat_id, user_id, role, last_read_at, joined_at)
--   aitel_profiles(id, username, display_name, avatar_url, is_verified ...)
-- اگر ستون یا قید دیگری دارید (مثلاً NOT NULL اضافه)، تابع aitel_system_get_direct_chat را مطابق آن تنظیم کنید.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) تحویل واقعی پیام: زمانی که برنامه‌ی گیرنده پیام‌ها را روی دستگاه دریافت کرده
-- ---------------------------------------------------------------------
alter table public.aitel_chat_members
  add column if not exists last_delivered_at timestamptz;

-- ثبت خواندن (زمان سرور؛ خواندن، تحویل را هم ثبت می‌کند)
create or replace function public.aitel_mark_chat_read(p_chat_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.aitel_chat_members
     set last_read_at = now(),
         last_delivered_at = now()
   where chat_id = p_chat_id
     and user_id = auth.uid();
end;
$$;

-- ثبت تحویل یک گفتگو
create or replace function public.aitel_mark_chat_delivered(p_chat_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.aitel_chat_members
     set last_delivered_at = now()
   where chat_id = p_chat_id
     and user_id = auth.uid();
end;
$$;

-- ثبت تحویل برای همه‌ی گفتگوهای غیرکانالِ کاربر (هنگام باز شدن برنامه / اتصال مجدد Realtime)
create or replace function public.aitel_mark_all_delivered()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.aitel_chat_members m
     set last_delivered_at = now()
    from public.aitel_chats c
   where c.id = m.chat_id
     and c.chat_type <> 'channel'
     and m.user_id = auth.uid();
end;
$$;

revoke all on function public.aitel_mark_chat_read(uuid)      from public, anon;
revoke all on function public.aitel_mark_chat_delivered(uuid) from public, anon;
revoke all on function public.aitel_mark_all_delivered()      from public, anon;
grant execute on function public.aitel_mark_chat_read(uuid)      to authenticated;
grant execute on function public.aitel_mark_chat_delivered(uuid) to authenticated;
grant execute on function public.aitel_mark_all_delivered()      to authenticated;

-- ---------------------------------------------------------------------
-- 2) دیدن رسید اعضا فقط در PV و گروه (نه کانال‌ها؛ برای حریم خصوصی اعضای کانال)
--    این سیاست OR می‌شود با سیاست‌های موجود و چیزی را محدودتر نمی‌کند.
-- ---------------------------------------------------------------------
create or replace function public.aitel_can_see_chat_members(p_chat_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.aitel_chat_members me
                  where me.chat_id = p_chat_id and me.user_id = auth.uid())
     and exists (select 1 from public.aitel_chats c
                  where c.id = p_chat_id and c.chat_type <> 'channel');
$$;
revoke all on function public.aitel_can_see_chat_members(uuid) from public, anon;
grant execute on function public.aitel_can_see_chat_members(uuid) to authenticated;

drop policy if exists aitel_members_select_same_chat on public.aitel_chat_members;
create policy aitel_members_select_same_chat
  on public.aitel_chat_members
  for select to authenticated
  using (public.aitel_can_see_chat_members(chat_id));

-- ---------------------------------------------------------------------
-- 3) Realtime برای تغییر last_read_at / last_delivered_at اعضا (به‌روزرسانی لحظه‌ای تیک‌ها)
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'aitel_chat_members'
  ) then
    alter publication supabase_realtime add table public.aitel_chat_members;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4) جدول‌های سیستمی ربات (فقط service_role؛ RLS فعال و بدون هیچ policy برای کاربران)
-- ---------------------------------------------------------------------
create table if not exists public.aitel_system_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.aitel_system_events (
  event_key  text primary key,                    -- مثل registration:<uid> ، welcome:<uid> ، feedback:<id>
  event_type text not null,
  user_id    uuid,
  status     text not null default 'pending' check (status in ('pending','sent','failed')),
  attempts   int  not null default 1,
  payload    jsonb not null default '{}'::jsonb,
  claimed_at timestamptz not null default now(),
  sent_at    timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

alter table public.aitel_system_settings enable row level security;
alter table public.aitel_system_events   enable row level security;
revoke all on public.aitel_system_settings from anon, authenticated;
revoke all on public.aitel_system_events   from anon, authenticated;

-- «رزرو» اتمیک یک رویداد: true فقط برای اولین (یا بعد از شکست/انقضا) فراخوانی
create or replace function public.aitel_claim_system_event(
  p_key text, p_type text, p_user uuid, p_payload jsonb default '{}'::jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  insert into public.aitel_system_events as e (event_key, event_type, user_id, payload)
  values (p_key, p_type, p_user, coalesce(p_payload,'{}'::jsonb))
  on conflict (event_key) do update
     set status = 'pending',
         claimed_at = now(),
         attempts = e.attempts + 1
   where e.status <> 'sent'
     and (e.status = 'failed' or e.claimed_at < now() - interval '2 minutes');
  get diagnostics n = row_count;
  return n > 0;
end;
$$;
revoke all on function public.aitel_claim_system_event(text,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.aitel_claim_system_event(text,text,uuid,jsonb) to service_role;

-- پیدا کردن/ساختن PV بین دو حساب (فقط برای Edge Function)
create or replace function public.aitel_system_get_direct_chat(p_a uuid, p_b uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v uuid;
begin
  if p_a = p_b then raise exception 'same user'; end if;
  perform pg_advisory_xact_lock(hashtext(least(p_a::text,p_b::text) || greatest(p_a::text,p_b::text)));

  select c.id into v
    from public.aitel_chats c
   where c.chat_type = 'direct'
     and exists (select 1 from public.aitel_chat_members m where m.chat_id = c.id and m.user_id = p_a)
     and exists (select 1 from public.aitel_chat_members m where m.chat_id = c.id and m.user_id = p_b)
   limit 1;
  if v is not null then return v; end if;

  insert into public.aitel_chats (chat_type, created_by, title)
  values ('direct', p_a, 'AITEL Bot')
  returning id into v;

  insert into public.aitel_chat_members (chat_id, user_id, role)
  values (v, p_a, 'member'), (v, p_b, 'member');
  return v;
end;
$$;
revoke all on function public.aitel_system_get_direct_chat(uuid,uuid) from public, anon, authenticated;
grant execute on function public.aitel_system_get_direct_chat(uuid,uuid) to service_role;

-- ---------------------------------------------------------------------
-- 5) username رزروشده‌ی ربات: هیچ کاربر عادی نمی‌تواند @aitel_bot را بردارد
-- ---------------------------------------------------------------------
create or replace function public.aitel_protect_reserved_usernames()
returns trigger
language plpgsql
as $$
begin
  if lower(coalesce(new.username,'')) = 'aitel_bot'
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'این نام کاربری رزرو شده است.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists aitel_reserved_usernames on public.aitel_profiles;
create trigger aitel_reserved_usernames
  before insert or update of username on public.aitel_profiles
  for each row execute function public.aitel_protect_reserved_usernames();

-- ---------------------------------------------------------------------
-- 6) Backfill: کاربران فعلی نباید بعد از انتشار نسخه‌ی جدید اعلان ثبت‌نام/خوشامد بگیرند
-- ---------------------------------------------------------------------
insert into public.aitel_system_events (event_key, event_type, user_id, status, payload, sent_at)
select 'registration:' || p.id, 'new_registration', p.id, 'sent', '{"backfilled":true}'::jsonb, now()
  from public.aitel_profiles p
on conflict (event_key) do nothing;

insert into public.aitel_system_events (event_key, event_type, user_id, status, payload, sent_at)
select 'welcome:' || p.id, 'welcome', p.id, 'sent', '{"backfilled":true}'::jsonb, now()
  from public.aitel_profiles p
on conflict (event_key) do nothing;

commit;
