# Legacy — Abandoned WhatsApp Surrogate Pipeline

These files are from the original v1 idea: an AI that joined Google Meet classes and replied on WhatsApp as you.

The approach was abandoned because:
- Browserbase cloud browser sessions are expensive
- WhatsApp Web automation is fragile and against WhatsApp's TOS
- The Telegram bot approach is simpler, faster, and more reliable

## Files here

| File | Original purpose |
|---|---|
| `browserbase.js` | Controlled a cloud Chromium session via Browserbase to send WhatsApp messages |
| `gemma.js` | Prompted Gemma 3:4b to extract structured fields (subject, time, room, what-changed) from a meeting transcript |

## What replaced them

- `server/telegram_bot.js` — Telegram long-poll bot with passcode gate, cooldown, and daily voice quota
- `server/circular_digest.js` — Cleans raw faculty emails into Telegram-safe formatted notices with spoken voice scripts
