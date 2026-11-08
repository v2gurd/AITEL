-- AITEL additive upgrade. Safe to run after the existing messaging foundation.
-- Does not drop or rewrite existing chats, messages, profiles, or auth settings.

begin;

-- Chat metadata: keep is_group for backwards compatibility.
alter table public.aitel_chats
  add column if not exists chat_type text,
  add column if not exists description text,
  add column if not exists username text,
  add column if not exists is_public boolean not null default false,
  add column if not exists avatar_url text,
  add column if not exists is_verified boolean not null default false;

update public.aitel_chats
set chat_type = case when is_group then 'group' else 'private' end
where chat_type is null;

alter table public.aitel_chats
  alter column chat_type set default 'private';

alter table public.aitel_chats
  drop constraint if exists aitel_chats_chat_type_check;
alter table public.aitel_chats
  add constraint aitel_chats_chat_type_check
  check (chat_type in ('private','group','channel'));

create unique index if not exists aitel_chats_username_unique
  on public.aitel_chats (lower(username))
  where username is not null;

alter table public.aitel_profiles
  add column if not exists is_verified boolean not null default false;

-- Users must never be able to grant themselves a verification badge.
create or replace function public.aitel_guard_profile_verification()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is not null and new.is_verified is distinct from old.is_verified then
    raise exception 'Verification status can only be changed by an administrator';
  end if;
  return new;
end;
$$;

drop trigger if exists aitel_profile_verification_guard on public.aitel_profiles;
create trigger aitel_profile_verification_guard
before update on public.aitel_profiles
for each row execute function public.aitel_guard_profile_verification();

-- Personal Saved Messages. Content is snapshotted so it remains available
-- even if the original message is deleted or its chat is removed.
create table if not exists public.aitel_saved_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_message_id uuid null references public.aitel_messages(id) on delete set null,
  message_type text not null default 'text',
  content text not null default '',
  media_path text,
  media_mime text,
  media_size bigint,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists aitel_saved_messages_user_created_idx
  on public.aitel_saved_messages(user_id, created_at desc);

alter table public.aitel_saved_messages enable row level security;
drop policy if exists "saved messages select own" on public.aitel_saved_messages;
drop policy if exists "saved messages insert own" on public.aitel_saved_messages;
drop policy if exists "saved messages delete own" on public.aitel_saved_messages;
create policy "saved messages select own" on public.aitel_saved_messages
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "saved messages insert own" on public.aitel_saved_messages
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "saved messages delete own" on public.aitel_saved_messages
  for delete to authenticated using ((select auth.uid()) = user_id);
grant select, insert, delete on public.aitel_saved_messages to authenticated;

-- Delivery/read receipts. A user may manage only their own receipt;
-- a sender may read receipts for messages they sent.
create table if not exists public.aitel_message_receipts (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.aitel_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique(message_id, user_id)
);
create index if not exists aitel_message_receipts_user_idx
  on public.aitel_message_receipts(user_id, message_id);

alter table public.aitel_message_receipts enable row level security;
drop policy if exists "receipts select own or sender" on public.aitel_message_receipts;
drop policy if exists "receipts insert own participant" on public.aitel_message_receipts;
drop policy if exists "receipts update own" on public.aitel_message_receipts;
create policy "receipts select own or sender" on public.aitel_message_receipts
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.aitel_messages m
      where m.id = message_id and m.sender_id = (select auth.uid())
    )
  );
create policy "receipts insert own participant" on public.aitel_message_receipts
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.aitel_messages m
      join public.aitel_chat_members cm on cm.chat_id = m.chat_id
      where m.id = message_id and cm.user_id = (select auth.uid())
    )
  );
create policy "receipts update own" on public.aitel_message_receipts
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
grant select, insert, update on public.aitel_message_receipts to authenticated;

-- Web Push subscription records. Private key must stay in Edge Function secrets.
create table if not exists public.aitel_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists aitel_push_subscriptions_user_idx
  on public.aitel_push_subscriptions(user_id);

alter table public.aitel_push_subscriptions enable row level security;
drop policy if exists "push subscriptions select own" on public.aitel_push_subscriptions;
drop policy if exists "push subscriptions insert own" on public.aitel_push_subscriptions;
drop policy if exists "push subscriptions update own" on public.aitel_push_subscriptions;
drop policy if exists "push subscriptions delete own" on public.aitel_push_subscriptions;
create policy "push subscriptions select own" on public.aitel_push_subscriptions
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "push subscriptions insert own" on public.aitel_push_subscriptions
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "push subscriptions update own" on public.aitel_push_subscriptions
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "push subscriptions delete own" on public.aitel_push_subscriptions
  for delete to authenticated using ((select auth.uid()) = user_id);
grant select, insert, update, delete on public.aitel_push_subscriptions to authenticated;

commit;
