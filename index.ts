// supabase/functions/aitel-system-bot/index.ts  (AITEL v1.8)
// ربات رسمی @aitel_bot — پیام‌ها داخل خود AITEL ارسال می‌شوند.
//
// verify_jwt = true  → فقط کاربر واردشده می‌تواند صدا بزند؛ هویت فقط از JWT می‌آید (نه از body).
// کلید سرویس فقط همین‌جا (محیط امن سرور) استفاده می‌شود و هرگز به HTML نمی‌رسد.
//
// شناسه‌ی ربات و ادمین از جدول aitel_system_settings (bot_user_id / admin_user_id) خوانده می‌شود.
// اختیاری: Secret با نام ADMIN_USER_ID اولویت دارد:
//     supabase secrets set ADMIN_USER_ID=<uuid> --project-ref psvesfkxtmlnjyhphsfs
// (یا Dashboard → Edge Functions → Secrets). اگر ست نشود، مقدار جدول استفاده می‌شود.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SECRET_KEY = (() => {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try { const k = JSON.parse(raw).default; if (k) return String(k); } catch { /* fall through */ }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
})();
const BOT_USERNAME = "aitel_bot";
const ADMIN_USERNAME = Deno.env.get("ADMIN_USERNAME") ?? "ehsanews"; // فقط fallback نهایی
const ADMIN_USER_ID_ENV = Deno.env.get("ADMIN_USER_ID") ?? "";
const LOGO_URL = "https://v2gurd.github.io/AITEL/AITEL-Official-Logo.png";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const admin = SUPABASE_URL && SECRET_KEY
  ? createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });

const fmtDate = (v?: string | null) =>
  new Date(v ?? Date.now()).toLocaleString("fa-IR", {
    timeZone: "Asia/Tehran", dateStyle: "medium", timeStyle: "short",
  });

const FEEDBACK_LABELS: Record<string, string> = {
  bug: "گزارش ایراد", suggestion: "پیشنهاد", feature: "قابلیت جدید", report: "گزارش",
};

// ---------- ربات و ادمین ----------
let cachedBotId = "";
let cachedAdminId = "";

async function getSetting(key: string): Promise<string> {
  const { data } = await admin!.from("aitel_system_settings").select("value").eq("key", key).maybeSingle();
  return (data?.value as string | undefined) ?? "";
}
async function putSetting(key: string, value: string) {
  await admin!.from("aitel_system_settings")
    .upsert({ key, value }, { onConflict: "key", ignoreDuplicates: true });
}

async function getBotId(): Promise<string> {
  if (cachedBotId) return cachedBotId;
  let id = await getSetting("bot_user_id");
  if (!id) {
    const { data: p } = await admin!.from("aitel_profiles").select("id").eq("username", BOT_USERNAME).maybeSingle();
    if (p?.id) { id = p.id as string; await putSetting("bot_user_id", id); }
  }
  if (!id) {
    // آخرین راه: ساخت حساب (معمولاً Migration آن را از قبل ساخته است). ورود به این حساب ممکن نیست.
    const { data: created, error } = await admin!.auth.admin.createUser({
      email: `aitel-system-bot-${crypto.randomUUID().slice(0, 8)}@system.invalid`,
      password: crypto.randomUUID() + crypto.randomUUID() + "Aa9!",
      email_confirm: true,
      ban_duration: "876000h",
      user_metadata: { full_name: "ربات رسمی ایتل", is_system_bot: true },
    });
    if (error || !created?.user) throw new Error("bot_user_create_failed: " + (error?.message ?? ""));
    const botId = created.user.id;
    const { error: pErr } = await admin!.from("aitel_profiles").upsert({
      id: botId, display_name: "ربات رسمی ایتل", username: BOT_USERNAME,
      bio: "حساب سیستمی و رسمی AITEL", avatar_url: LOGO_URL, photo_urls: [LOGO_URL], is_verified: true,
    });
    if (pErr) {
      await admin!.auth.admin.deleteUser(botId); // رقابت هم‌زمان: دیگری قبلاً ساخته است
      const { data: again } = await admin!.from("aitel_profiles").select("id").eq("username", BOT_USERNAME).maybeSingle();
      if (!again?.id) throw new Error("bot_profile_failed: " + pErr.message);
      id = again.id as string;
    } else {
      id = botId;
    }
    await putSetting("bot_user_id", id);
  }
  cachedBotId = id;
  return id;
}

async function getAdminId(): Promise<string> {
  if (cachedAdminId) return cachedAdminId;
  let id = ADMIN_USER_ID_ENV || await getSetting("admin_user_id");
  if (!id) {
    const { data } = await admin!.from("aitel_profiles").select("id").eq("username", ADMIN_USERNAME).maybeSingle();
    id = (data?.id as string | undefined) ?? "";
  }
  if (!id) throw new Error("admin_not_found");
  const { data: exists } = await admin!.from("aitel_profiles").select("id").eq("id", id).maybeSingle();
  if (!exists) throw new Error("admin_not_found");
  cachedAdminId = id;
  return id;
}

async function sendBotMessage(botId: string, toUserId: string, content: string, meta: Record<string, unknown>) {
  const { data: chatId, error } = await admin!.rpc("aitel_system_get_direct_chat", { p_a: botId, p_b: toUserId });
  if (error || !chatId) throw new Error("direct_chat_failed: " + (error?.message ?? ""));
  const text = content.length > 3800 ? content.slice(0, 3790) + "…" : content;
  const { error: mErr } = await admin!.from("aitel_messages").insert({
    chat_id: chatId, sender_id: botId, message_type: "text", content: text, metadata: meta,
  });
  if (mErr) throw new Error("message_insert_failed: " + mErr.message);
}

// ---------- idempotency ----------
async function claim(key: string, type: string, userId: string, payload: unknown) {
  const { data, error } = await admin!.rpc("aitel_claim_system_event", {
    p_key: key, p_type: type, p_user: userId, p_payload: payload ?? {},
  });
  if (error) throw new Error("claim_failed: " + error.message);
  return data === true;
}
async function finish(key: string, ok: boolean, err?: string) {
  await admin!.from("aitel_system_events").update(
    ok ? { status: "sent", sent_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }
       : { status: "failed", last_error: (err ?? "").slice(0, 500), updated_at: new Date().toISOString() },
  ).eq("event_key", key);
}

// ثبت‌نام «واقعی» = پروفایل ساخته شده + شماره تلفن ثبت شده (سمت سرور از دیتابیس بررسی می‌شود)
async function loadRegistration(userId: string, authCreatedAt?: string) {
  const { data: profile } = await admin!.from("aitel_profiles")
    .select("id,username,display_name,created_at").eq("id", userId).maybeSingle();
  if (!profile) return null;
  const { data: priv } = await admin!.from("aitel_private_profiles")
    .select("phone_e164").eq("user_id", userId).maybeSingle();
  if (!priv?.phone_e164) return null;
  return { profile, createdAt: (profile.created_at as string | undefined) ?? authCreatedAt };
}

// ---------- handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { ok: false, error: "method_not_allowed" });
  if (!admin) return reply(500, { ok: false, error: "server_misconfigured" });

  // احراز هویت: هویت فقط از JWT می‌آید
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return reply(401, { ok: false, error: "unauthorized" });
  const { data: auth, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !auth?.user) return reply(401, { ok: false, error: "unauthorized" });
  const caller = auth.user;

  let body: { event?: string; feedback_id?: string } = {};
  try { body = await req.json(); } catch { return reply(400, { ok: false, error: "bad_json" }); }

  const event = String(body?.event ?? "");
  if (!["new_registration", "welcome", "feedback"].includes(event)) {
    return reply(400, { ok: false, error: "unknown_event" });
  }

  let key = "";
  try {
    const botId = await getBotId();
    if (caller.id === botId) return reply(403, { ok: false, error: "forbidden" });

    // ---- اعلان ثبت‌نام برای ادمین ----
    if (event === "new_registration") {
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
            `تاریخ ثبت‌نام: ${fmtDate(reg.createdAt)}`,
            { system_event: event, event_key: key });
        }
        await finish(key, true);
        return reply(200, { ok: true, status: "sent" });
      } catch (e) { await finish(key, false, String(e)); throw e; }
    }

    // ---- خوشامدگویی به کاربر ----
    if (event === "welcome") {
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
          `— ربات رسمی ایتل`,
          { system_event: event, event_key: key });
        await finish(key, true);
        return reply(200, { ok: true, status: "sent" });
      } catch (e) { await finish(key, false, String(e)); throw e; }
    }

    // ---- گزارش ایراد / پیشنهاد (متن از جدول aitel_feedback خوانده می‌شود، نه از کلاینت) ----
    const fid = String(body.feedback_id ?? "");
    if (!fid) return reply(400, { ok: false, error: "feedback_id_required" });
    const { data: fb } = await admin.from("aitel_feedback").select("*").eq("id", fid).maybeSingle();
    if (!fb || fb.user_id !== caller.id) return reply(403, { ok: false, error: "forbidden" });

    const { data: prof } = await admin.from("aitel_profiles")
      .select("display_name,username").eq("id", caller.id).maybeSingle();
    key = `feedback:${fid}`;
    if (!(await claim(key, "feedback", caller.id, { feedback_id: fid }))) {
      return reply(200, { ok: true, status: "already_sent" });
    }
    try {
      const adminId = await getAdminId();
      const label = FEEDBACK_LABELS[fb.feedback_type as string] ?? "گزارش";
      await sendBotMessage(botId, adminId,
        `📩 ${label} جدید\n\n` +
        `از: ${prof?.display_name ?? fb.display_name ?? "—"} (@${prof?.username ?? fb.username ?? "—"})\n` +
        `شناسه کاربر: ${caller.id}\n` +
        `نوع: ${label}\n` +
        `زمان: ${fmtDate(fb.created_at as string)}\n\n` +
        `متن کامل:\n${fb.content}`,
        { system_event: event, event_key: key, feedback_id: fid });
      await finish(key, true);
      return reply(200, { ok: true, status: "sent" });
    } catch (e) { await finish(key, false, String(e)); throw e; }
  } catch (e) {
    console.error("aitel-system-bot:", e);
    return reply(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
