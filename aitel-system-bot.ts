// supabase/functions/aitel-system-bot/index.ts
// ربات رسمی @aitel_bot — پیام‌ها داخل خود AITEL ارسال می‌شوند.
//
// Secrets (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY به‌صورت خودکار در Edge Function موجودند):
//   ADMIN_USER_ID   (اختیاری ولی پیشنهادی) شناسه‌ی حساب ادمین؛ پایدارتر از username است
//   ADMIN_USERNAME  (اختیاری) پیش‌فرض: ehsanews
//
// Deploy:  supabase functions deploy aitel-system-bot      (verify_jwt را روشن نگه دارید)

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_USERNAME = "aitel_bot";
const ADMIN_USERNAME = Deno.env.get("ADMIN_USERNAME") ?? "ehsanews";
const ADMIN_USER_ID = Deno.env.get("ADMIN_USER_ID") ?? "";
const LOGO_URL = "https://v2gurd.github.io/AITEL/AITEL-Official-Logo.png";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const fmtDate = (v?: string | null) =>
  new Date(v ?? Date.now()).toLocaleString("fa-IR", {
    timeZone: "Asia/Tehran",
    dateStyle: "medium",
    timeStyle: "short",
  });

const FEEDBACK_LABELS: Record<string, string> = {
  bug: "گزارش ایراد",
  suggestion: "پیشنهاد",
  feature: "قابلیت جدید",
};

// ---------- ربات ----------
async function getBotId(): Promise<string> {
  const { data: s } = await admin
    .from("aitel_system_settings").select("value").eq("key", "bot_user_id").maybeSingle();
  if (s?.value) return s.value;

  // ساخت حساب احراز هویت برای ربات (بدون امکان ورود؛ رمز تصادفی دور ریخته می‌شود)
  const password = crypto.randomUUID() + crypto.randomUUID();
  const { data: created, error } = await admin.auth.admin.createUser({
    email: `aitel-system-bot-${crypto.randomUUID().slice(0, 8)}@example.com`,
    password,
    email_confirm: true,
    user_metadata: { full_name: "ربات رسمی ایتل", is_system_bot: true },
  });
  if (error || !created?.user) throw new Error("bot_user_create_failed: " + (error?.message ?? ""));
  const botId = created.user.id;

  const { error: pErr } = await admin.from("aitel_profiles").upsert({
    id: botId,
    display_name: "ربات رسمی ایتل",
    username: BOT_USERNAME,
    bio: "حساب سیستمی و رسمی AITEL",
    avatar_url: LOGO_URL,
    photo_urls: [LOGO_URL],
    is_verified: true,
  });
  if (pErr) {
    await admin.auth.admin.deleteUser(botId);
    throw new Error("bot_profile_failed: " + pErr.message);
  }

  await admin.from("aitel_system_settings")
    .upsert({ key: "bot_user_id", value: botId }, { onConflict: "key", ignoreDuplicates: true });
  const { data: again } = await admin
    .from("aitel_system_settings").select("value").eq("key", "bot_user_id").maybeSingle();
  return again?.value ?? botId;
}

async function getAdminId(): Promise<string> {
  if (ADMIN_USER_ID) return ADMIN_USER_ID;
  const { data } = await admin
    .from("aitel_profiles").select("id").eq("username", ADMIN_USERNAME).maybeSingle();
  if (!data?.id) throw new Error("admin_not_found");
  return data.id;
}

async function sendBotMessage(botId: string, toUserId: string, content: string) {
  const { data: chatId, error } = await admin.rpc("aitel_system_get_direct_chat", {
    p_a: botId, p_b: toUserId,
  });
  if (error || !chatId) throw new Error("direct_chat_failed: " + (error?.message ?? ""));
  const { error: mErr } = await admin.from("aitel_messages").insert({
    chat_id: chatId, sender_id: botId, message_type: "text", content: content.slice(0, 3800),
  });
  if (mErr) throw new Error("message_insert_failed: " + mErr.message);
  await admin.from("aitel_chats").update({ updated_at: new Date().toISOString() }).eq("id", chatId);
}

// ---------- idempotency ----------
async function claim(key: string, type: string, userId: string, payload: unknown) {
  const { data, error } = await admin.rpc("aitel_claim_system_event", {
    p_key: key, p_type: type, p_user: userId, p_payload: payload ?? {},
  });
  if (error) throw new Error("claim_failed: " + error.message);
  return data === true;
}
async function finish(key: string, ok: boolean, err?: string) {
  await admin.from("aitel_system_events").update(
    ok ? { status: "sent", sent_at: new Date().toISOString(), last_error: null }
       : { status: "failed", last_error: (err ?? "").slice(0, 500) },
  ).eq("event_key", key);
}

// ثبت‌نام «واقعی» = پروفایل ساخته شده + شماره تلفن ثبت شده (سمت سرور بررسی می‌شود)
async function loadRegistration(userId: string, authCreatedAt?: string) {
  const { data: profile } = await admin
    .from("aitel_profiles").select("*").eq("id", userId).maybeSingle();
  if (!profile) return null;
  const { data: priv } = await admin
    .from("aitel_private_profiles").select("phone_e164").eq("user_id", userId).maybeSingle();
  if (!priv?.phone_e164) return null;
  return { profile, createdAt: (profile.created_at as string | undefined) ?? authCreatedAt };
}

// ---------- handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { ok: false, error: "method_not_allowed" });

  // احراز هویت: هویت فقط از JWT می‌آید، نه از body
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return reply(401, { ok: false, error: "unauthorized" });
  const { data: auth, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !auth?.user) return reply(401, { ok: false, error: "unauthorized" });
  const caller = auth.user;

  let body: { event?: string; feedback_id?: string } = {};
  try { body = await req.json(); } catch { return reply(400, { ok: false, error: "bad_json" }); }

  let key = "";
  try {
    const botId = await getBotId();

    // ---- اعلان ثبت‌نام برای ادمین ----
    if (body.event === "new_registration") {
      const reg = await loadRegistration(caller.id, caller.created_at);
      if (!reg) return reply(200, { ok: true, status: "pending_phone" });
      key = `registration:${caller.id}`;
      if (!(await claim(key, "new_registration", caller.id, {}))) {
        return reply(200, { ok: true, status: "already_sent" });
      }
      try {
        const adminId = await getAdminId();
        if (adminId !== caller.id) {
          await sendBotMessage(botId, adminId,
            `🆕 ثبت‌نام کاربر جدید در AITEL\n\n` +
            `نام نمایشی: ${reg.profile.display_name ?? "—"}\n` +
            `نام کاربری: @${reg.profile.username ?? "—"}\n` +
            `شناسه کاربر: ${caller.id}\n` +
            `تاریخ ثبت‌نام: ${fmtDate(reg.createdAt)}`);
        }
        await finish(key, true);
        return reply(200, { ok: true, status: "sent" });
      } catch (e) { await finish(key, false, String(e)); throw e; }
    }

    // ---- خوشامدگویی به کاربر ----
    if (body.event === "welcome") {
      const reg = await loadRegistration(caller.id, caller.created_at);
      if (!reg) return reply(200, { ok: true, status: "pending_phone" });
      key = `welcome:${caller.id}`;
      if (!(await claim(key, "welcome", caller.id, {}))) {
        return reply(200, { ok: true, status: "already_sent" });
      }
      try {
        await sendBotMessage(botId, caller.id,
          `سلام ${reg.profile.display_name ?? ""} 👋\n` +
          `به AITEL خوش آمدی! حساب تو با موفقیت ساخته شد.\n\n` +
          `از بخش جست‌وجو می‌توانی کاربران را پیدا کنی و گفتگو را شروع کنی، ` +
          `در کانال‌ها عضو شوی و از تنظیمات، تم دلخواهت را انتخاب کنی.\n` +
          `اگر ایراد یا پیشنهادی داشتی، از «تنظیمات ← گزارش ایراد یا پیشنهاد» برایمان بفرست.\n\n` +
          `— ربات رسمی ایتل`);
        await finish(key, true);
        return reply(200, { ok: true, status: "sent" });
      } catch (e) { await finish(key, false, String(e)); throw e; }
    }

    // ---- گزارش ایراد / پیشنهاد ----
    if (body.event === "feedback") {
      const fid = String(body.feedback_id ?? "");
      if (!fid) return reply(400, { ok: false, error: "feedback_id_required" });
      const { data: fb } = await admin
        .from("aitel_feedback").select("*").eq("id", fid).maybeSingle();
      if (!fb || fb.user_id !== caller.id) return reply(403, { ok: false, error: "forbidden" });

      const { data: prof } = await admin
        .from("aitel_profiles").select("display_name,username").eq("id", caller.id).maybeSingle();
      key = `feedback:${fid}`;
      if (!(await claim(key, "feedback", caller.id, { feedback_id: fid }))) {
        return reply(200, { ok: true, status: "already_sent" });
      }
      try {
        const adminId = await getAdminId();
        await sendBotMessage(botId, adminId,
          `📩 ${FEEDBACK_LABELS[fb.feedback_type] ?? "گزارش"} جدید\n\n` +
          `از: ${prof?.display_name ?? fb.display_name ?? "—"} (@${prof?.username ?? fb.username ?? "—"})\n` +
          `شناسه کاربر: ${caller.id}\n` +
          `نوع: ${FEEDBACK_LABELS[fb.feedback_type] ?? fb.feedback_type}\n` +
          `زمان: ${fmtDate(fb.created_at)}\n\n` +
          `متن کامل:\n${fb.content}`);
        await finish(key, true);
        return reply(200, { ok: true, status: "sent" });
      } catch (e) { await finish(key, false, String(e)); throw e; }
    }

    return reply(400, { ok: false, error: "unknown_event" });
  } catch (e) {
    console.error("aitel-system-bot:", e);
    return reply(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
