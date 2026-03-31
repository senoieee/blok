const { Telegraf, Markup } = require("telegraf");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");
const express = require("express");

// ─── ENV ──────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const API_ID       = parseInt(process.env.API_ID);
const API_HASH     = process.env.API_HASH;
const SESSION_STR  = process.env.SESSION_STRING || "";
const OWNER_ID     = parseInt(process.env.OWNER_ID);
const PORT         = process.env.PORT || 3000;

// ─── INIT ─────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
let userbot = null;

// state per owner chat
const state = {
  channel: null,       // { id, title, username, memberCount }
  waiting: false,      // waiting for channel input
  running: false,      // operation in progress
  cancelFlag: false,
};

// ─── SLEEP ────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── USERBOT ──────────────────────────────────────────────
async function startUserbot() {
  const session = new StringSession(SESSION_STR);
  userbot = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
  });
  await userbot.connect();
  console.log("✅ Userbot connected");
}

// ─── FETCH ALL MEMBERS ────────────────────────────────────
async function fetchAllMembers(channelEntity, onProgress) {
  let offset = 0;
  const limit = 200;
  const all = [];

  while (true) {
    const result = await userbot.invoke(
      new Api.channels.GetParticipants({
        channel: channelEntity,
        filter: new Api.ChannelParticipantsRecent(),
        offset,
        limit,
        hash: BigInt(0),
      })
    );

    const users = result.users || [];
    if (users.length === 0) break;
    all.push(...users);
    offset += users.length;
    if (onProgress) onProgress(all.length, result.count || all.length);
    if (offset >= (result.count || 0)) break;
    await sleep(1200); // anti-flood
  }

  return all;
}

// ─── FILTERS ──────────────────────────────────────────────
function isDeleted(u)  { return !!u.deleted; }
function isBot(u)      { return !!u.bot; }
function isScam(u)     { return !!(u.scam || u.fake); }
function isRestricted(u) { return !!u.restricted; }

function isFake(u) {
  // No profile photo AND (name is 1-2 chars OR looks like random string)
  const hasPhoto   = !!(u.photo);
  const firstName  = (u.firstName || "").trim();
  const lastName   = (u.lastName  || "").trim();
  const fullName   = (firstName + lastName).replace(/\s/g, "");
  const shortName  = fullName.length <= 2;
  const randomLook = /^[a-z]{3,8}\d{3,}$/i.test(fullName); // e.g. user1234
  return !hasPhoto && (shortName || randomLook);
}

const FILTERS = {
  deleted:    { label: "🗑 حسابات محذوفة",            check: isDeleted },
  fake:       { label: "👻 حسابات وهمية",              check: isFake    },
  bot:        { label: "🤖 بوتات",                     check: isBot     },
  scam:       { label: "🚨 احتيال / Scam",             check: isScam    },
  restricted: { label: "⛔ محظورين من تيليجرام",       check: isRestricted },
  all:        { label: "💣 طرد الجميع (تصفير كامل)",  check: () => true  },
};

// ─── KICK ─────────────────────────────────────────────────
async function kickUser(channelId, userId) {
  try {
    await bot.telegram.banChatMember(channelId, userId);
    await sleep(300);
    await bot.telegram.unbanChatMember(channelId, userId);
    return true;
  } catch {
    return false;
  }
}

// ─── MAIN OPERATION ───────────────────────────────────────
async function runOperation(ctx, filterKey) {
  if (state.running) {
    return ctx.reply("⚠️ عملية جارية بالفعل. انتظر أو اضغط ⛔ إيقاف.");
  }
  if (!state.channel) {
    return ctx.reply("❌ لم تحدد قناة. أرسل /start وأضف قناة أولاً.");
  }

  const filter = FILTERS[filterKey];
  state.running    = true;
  state.cancelFlag = false;

  // --- status message ---
  const msg = await ctx.reply(
    `🔄 *جاري جلب أعضاء القناة...*\n📢 ${state.channel.title}`,
    { parse_mode: "Markdown" }
  );

  const edit = (text) =>
    ctx.telegram
      .editMessageText(ctx.chat.id, msg.message_id, null, text, { parse_mode: "Markdown" })
      .catch(() => {});

  // --- fetch members ---
  let members = [];
  try {
    const entity = state.channel.username
      ? state.channel.username
      : BigInt(state.channel.id);

    members = await fetchAllMembers(entity, async (fetched, total) => {
      await edit(`🔄 *جلب الأعضاء...*\n📥 ${fetched} / ${total}`);
    });
  } catch (e) {
    await edit(`❌ *فشل جلب الأعضاء:*\n\`${e.message}\``);
    state.running = false;
    return;
  }

  const total = members.length;
  await edit(`✅ *تم جلب ${total} عضو*\n🔍 جاري تطبيق الفلتر: ${filter.label}`);
  await sleep(600);

  // --- filter ---
  const targets = filterKey === "all"
    ? members
    : members.filter(filter.check);

  await edit(
    `🎯 *سيتم طرد: ${targets.length} عضو*\n` +
    `📊 الإجمالي: ${total}\n\n` +
    `⚡ بدء العملية...`
  );
  await sleep(500);

  // --- kick loop ---
  let kicked = 0, skipped = 0, errors = 0;

  for (let i = 0; i < targets.length; i++) {
    if (state.cancelFlag) break;

    const user = targets[i];
    const channelId = state.channel.username
      ? `@${state.channel.username}`
      : state.channel.id;

    const ok = await kickUser(channelId, user.id.valueOf());
    if (ok) kicked++; else errors++;

    // update every 5 kicks
    if ((i + 1) % 5 === 0 || i === targets.length - 1) {
      const pct = Math.round(((i + 1) / targets.length) * 100);
      await edit(
        `⚡ *${filter.label}*\n\n` +
        `📊 التقدم: ${pct}%  (${i + 1}/${targets.length})\n` +
        `✅ مطرودين: ${kicked}\n` +
        `❌ أخطاء: ${errors}\n\n` +
        `_اضغط ⛔ إيقاف للإلغاء_`
      );
    }

    await sleep(600); // flood protection
  }

  // --- done ---
  state.running = false;
  const status  = state.cancelFlag ? "⛔ تم الإيقاف يدوياً" : "✅ اكتملت العملية!";

  await edit(
    `${status}\n\n` +
    `📢 *القناة:* ${state.channel.title}\n` +
    `🎯 *الفلتر:* ${filter.label}\n\n` +
    `📊 *النتيجة:*\n` +
    `• إجمالي الأعضاء: ${total}\n` +
    `• مستهدفين: ${targets.length}\n` +
    `• ✅ مطرودين: ${kicked}\n` +
    `• ❌ أخطاء: ${errors}`
  );

  // return to main menu
  await showChannelMenu(ctx);
}

// ─── MENUS ────────────────────────────────────────────────
async function showMainMenu(ctx) {
  await ctx.reply(
    `🧹 *Channel Cleaner Bot*\n\nاضغط لإضافة قناة والبدء:`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("➕ إضافة قناة", "add_channel")],
        [Markup.button.callback("ℹ️ طريقة الاستخدام", "help")],
      ]),
    }
  );
}

async function showChannelMenu(ctx) {
  const ch = state.channel;
  if (!ch) return showMainMenu(ctx);

  const rows = Object.entries(FILTERS).map(([key, f]) => [
    Markup.button.callback(f.label, `op_${key}`),
  ]);

  rows.push([
    Markup.button.callback("🔄 تغيير القناة", "add_channel"),
    Markup.button.callback("⛔ إيقاف العملية", "cancel_op"),
  ]);

  await ctx.reply(
    `📢 *القناة المحددة:*\n${ch.title}\n@${ch.username || ch.id}\n\n` +
    `اختر العملية المطلوبة:`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(rows),
    }
  );
}

// ─── BOT HANDLERS ─────────────────────────────────────────
const ownerOnly = async (ctx, next) => {
  if (ctx.from?.id !== OWNER_ID) return;
  return next();
};

bot.use(ownerOnly);

bot.command("start", async (ctx) => {
  if (state.channel) {
    await showChannelMenu(ctx);
  } else {
    await showMainMenu(ctx);
  }
});

bot.command("stop", async (ctx) => {
  state.cancelFlag = true;
  await ctx.reply("⛔ جاري إيقاف العملية...");
});

// ── Inline button: add channel ────────────────────────────
bot.action("add_channel", async (ctx) => {
  await ctx.answerCbQuery();
  state.waiting = true;
  await ctx.reply(
    "📡 أرسل *@username* القناة أو *ID* القناة:\n\n" +
    "مثال: `@mychannel`\n\n" +
    "_تأكد أن البوت Admin في القناة مع صلاحية حظر المستخدمين_",
    { parse_mode: "Markdown" }
  );
});

// ── Inline button: help ───────────────────────────────────
bot.action("help", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `📖 *طريقة الاستخدام:*\n\n` +
    `1️⃣ اضغط ➕ إضافة قناة\n` +
    `2️⃣ أرسل @username القناة\n` +
    `3️⃣ اختر العملية من الأزرار\n` +
    `4️⃣ انتظر وشاهد النتائج\n\n` +
    `*الأزرار المتاحة:*\n` +
    `🗑 حسابات محذوفة — Deleted Accounts\n` +
    `👻 وهمية — بدون صورة + اسم قصير\n` +
    `🤖 بوتات — Bots\n` +
    `🚨 احتيال — Scam/Fake\n` +
    `⛔ محظورين من تيليجرام\n` +
    `💣 تصفير كامل — طرد الجميع\n\n` +
    `*ملاحظة:* البوت يجب أن يكون Admin في القناة`,
    { parse_mode: "Markdown" }
  );
});

// ── Inline button: cancel ─────────────────────────────────
bot.action("cancel_op", async (ctx) => {
  await ctx.answerCbQuery("⛔ جاري الإيقاف...");
  state.cancelFlag = true;
  if (!state.running) await ctx.reply("لا توجد عملية جارية.");
});

// ── Inline buttons: operations ────────────────────────────
bot.action(/^op_(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  if (!FILTERS[key]) return ctx.answerCbQuery("❌ فلتر غير معروف");

  // confirm for "all"
  if (key === "all") {
    await ctx.answerCbQuery();
    await ctx.reply(
      `⚠️ *تأكيد التصفير الكامل!*\n\n` +
      `سيتم طرد *جميع* أعضاء القناة.\nهل أنت متأكد؟`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("💣 نعم، طرد الجميع", "confirm_all")],
          [Markup.button.callback("❌ إلغاء", "back_menu")],
        ]),
      }
    );
    return;
  }

  await ctx.answerCbQuery(`⚡ بدأت: ${FILTERS[key].label}`);
  await runOperation(ctx, key);
});

bot.action("confirm_all", async (ctx) => {
  await ctx.answerCbQuery("💣 تأكيد!");
  await ctx.deleteMessage().catch(() => {});
  await runOperation(ctx, "all");
});

bot.action("back_menu", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
  await showChannelMenu(ctx);
});

// ── Text: receive channel username ────────────────────────
bot.on("text", async (ctx) => {
  if (!state.waiting) return;
  state.waiting = false;

  const input = ctx.message.text.trim();
  const username = input.startsWith("@") ? input.slice(1) : input;

  const loadMsg = await ctx.reply("🔄 جاري التحقق من القناة...");

  try {
    const entity = await userbot.getEntity(`@${username}`);
    const full   = await userbot.invoke(
      new Api.channels.GetFullChannel({ channel: `@${username}` })
    );

    state.channel = {
      id:          entity.id.valueOf(),
      title:       entity.title || username,
      username:    entity.username || username,
      memberCount: full.fullChat?.participantsCount || 0,
    };

    await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
    await ctx.reply(
      `✅ *تم التحقق من القناة*\n\n` +
      `📢 ${state.channel.title}\n` +
      `👥 الأعضاء: ${state.channel.memberCount.toLocaleString()}\n\n` +
      `اختر العملية:`,
      { parse_mode: "Markdown" }
    );
    await showChannelMenu(ctx);

  } catch (e) {
    await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
    await ctx.reply(
      `❌ *فشل التحقق من القناة*\n\n` +
      `\`${e.message}\`\n\n` +
      `تأكد من:\n• أن @${username} صحيح\n• البوت Admin في القناة\n• الحساب عضو في القناة`,
      { parse_mode: "Markdown" }
    );
    state.waiting = true;
  }
});

// ─── EXPRESS HEALTH ───────────────────────────────────────
const app = express();
app.get("/",       (_, res) => res.send("🧹 Channel Cleaner — Online"));
app.get("/health", (_, res) => res.json({ ok: true, running: state.running, channel: state.channel?.title }));
app.listen(PORT, () => console.log(`🌐 Port ${PORT}`));

// ─── LAUNCH ───────────────────────────────────────────────
(async () => {
  console.log("🚀 Starting...");
  await startUserbot();
  await bot.launch();
  console.log("✅ Bot running!");
})();

process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
