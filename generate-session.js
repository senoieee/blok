/**
 * شغّل هذا الملف مرة وحدة على جهازك:
 *   API_ID=xxx API_HASH=yyy node generate-session.js
 *
 * سيعطيك SESSION_STRING — ضعه في Railway Variables
 */
const { TelegramClient } = require("telegram");
const { StringSession }  = require("telegram/sessions");
const input = require("input");

const API_ID   = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;

(async () => {
  const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber: () => input.text("📞 رقم الهاتف (+966...): "),
    password:    () => input.text("🔐 كلمة المرور (Enter إذا ما في): "),
    phoneCode:   () => input.text("📨 كود تيليجرام: "),
    onError:     (e) => console.error(e),
  });

  console.log("\n✅ SESSION_STRING:\n");
  console.log(client.session.save());
  console.log("\nضع هذا في Railway كـ SESSION_STRING\n");

  await client.disconnect();
  process.exit(0);
})();
