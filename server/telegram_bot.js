import fs from 'fs';
import path from 'path';
import { synthesizeSpeech, transcribeAudio } from './elevenlabs.js';
import { searchDriveCatalog } from './drive_search.js';
import { searchLaptopMaterials } from './file_search.js';
import {
  getAnnouncements,
  saveAnnouncement,
  isDeadlineOrScheduleQuery,
  answerScheduleQuery
} from './announcements.js';
import { digestFacultyCircular } from './circular_digest.js';

// ───────────────────────── Config ─────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API_BASE = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'standln_cr_bot';

// Passcode must come from .env. No hardcoded fallback (the repo will be public).
const CLASS_PASSCODE = (process.env.CLASS_PASSCODE || '').trim().toUpperCase();

// The CR is identified by numeric Telegram chat ID, never by display name.
// Leave unset the first time, send /whoami to the bot, then copy your ID into .env.
const CR_CHAT_ID = String(process.env.CR_CHAT_ID || '').trim();
const isCR = (id) => CR_CHAT_ID !== '' && String(id) === CR_CHAT_ID;

// Optional: link to the root of the 6th-sem Drive. If unset, no hub link is shown.
const DRIVE_HUB_URL = (process.env.DRIVE_HUB_URL || '').trim();

const VOICE_DAILY_CAP = Number(process.env.VOICE_DAILY_CAP || 15); // per student per day
const REQUEST_COOLDOWN_MS = Number(process.env.REQUEST_COOLDOWN_MS || 4000);

const AUTH_FILE = path.join(process.cwd(), 'data', 'authorized_students.json');

// One shared list of examples so every message stays consistent.
const EXAMPLES = [
  'psp unit 2 notes',
  'fuses',
  'vlsi lab',
  'previous year papers',
  'when is the lab report due?'
];
const examplesText = () => EXAMPLES.map((e) => `• ${e}`).join('\n');

// ───────────────────────── Helpers ─────────────────────────

/** Escape characters that break Telegram legacy Markdown. */
const md = (s) => String(s ?? '').replace(/([_*`\[])/g, '\\$1');

/** Per-chat cooldown so spam can't drain the ElevenLabs quota. */
const lastSeen = new Map();
function tooFast(id, ms = REQUEST_COOLDOWN_MS) {
  const now = Date.now();
  const prev = lastSeen.get(id) || 0;
  lastSeen.set(id, now);
  return now - prev < ms;
}

/** Per-student daily voice-note cap. The CR is exempt. */
const voiceUse = new Map();
function canUseVoice(id) {
  if (isCR(id)) return true;
  const day = new Date().toISOString().slice(0, 10);
  const cur = voiceUse.get(String(id));
  if (!cur || cur.day !== day) {
    voiceUse.set(String(id), { day, count: 1 });
    return true;
  }
  if (cur.count >= VOICE_DAILY_CAP) return false;
  cur.count++;
  return true;
}

// ───────────────────────── Authorization ─────────────────────────

export function getAuthorizedStudents() {
  try {
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    if (!fs.existsSync(AUTH_FILE)) {
      fs.writeFileSync(AUTH_FILE, JSON.stringify([], null, 2));
      return [];
    }
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

export function isStudentAuthorized(chatId) {
  const list = getAuthorizedStudents();
  return list.some((s) => String(s.chatId) === String(chatId));
}

export function authorizeStudent(chatId, name) {
  const list = getAuthorizedStudents();
  if (!list.some((s) => String(s.chatId) === String(chatId))) {
    list.push({
      chatId: String(chatId),
      name: name || 'Student',
      authorizedAt: new Date().toISOString()
    });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(list, null, 2));
    console.log(`🛡️ [Passcode Gate] Authorized student: ${name} (Chat ID: ${chatId})`);
  }
}

let isPolling = false;
let lastUpdateId = 0;

// ───────────────────────── Telegram senders ─────────────────────────

/**
 * Send a text message. Uses Markdown, and retries as plain text if Telegram
 * rejects the formatting (so a stray "_" or "*" never silently drops a reply).
 */
export async function sendTelegramTextMessage(chatId, text) {
  const post = (body) =>
    fetch(`${TELEGRAM_API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then((r) => r.json());

  let data = await post({
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: false
  });

  if (!data.ok && /parse entities|can't parse/i.test(data.description || '')) {
    data = await post({ chat_id: chatId, text: text.replace(/[*_`\\]/g, '') });
  }
  if (!data.ok) console.warn('[Telegram sendMessage failed]:', data.description);
  return data;
}

/** Send an audio voice note via Telegram sendVoice */
export async function sendTelegramVoiceNote(chatId, audioBuffer, caption = '') {
  const url = `${TELEGRAM_API_BASE}/sendVoice`;
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('voice', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'cr_voice_note.mp3');
  if (caption) formData.append('caption', caption);

  const res = await fetch(url, { method: 'POST', body: formData });
  return await res.json();
}

/** Send a PDF document via Telegram sendDocument */
export async function sendTelegramDocument(chatId, filePath, fileName, caption = '') {
  const url = `${TELEGRAM_API_BASE}/sendDocument`;
  const fileBuffer = fs.readFileSync(filePath);
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('document', new Blob([fileBuffer], { type: 'application/pdf' }), fileName);
  if (caption) formData.append('caption', caption);

  const res = await fetch(url, { method: 'POST', body: formData });
  return await res.json();
}

/** Broadcast an announcement and optional voice note to all authorized students */
export async function broadcastAnnouncementToTelegram(title, text, voiceBuffer = null) {
  const students = getAuthorizedStudents().filter((s) => s.chatId && /^\d+$/.test(String(s.chatId)));
  console.log(`📢 [Telegram Broadcast] Broadcasting "${title}" to ${students.length} authorized students...`);

  const broadcastMsg =
    `📢 *Class announcement from your CR*\n\n` +
    `*${md(title)}*\n` +
    `${md(text)}\n\n` +
    `_Sent via StandIn_`;

  let sentCount = 0;
  for (const s of students) {
    try {
      await sendTelegramTextMessage(s.chatId, broadcastMsg);
      if (voiceBuffer && voiceBuffer.length > 0) {
        await sendTelegramVoiceNote(s.chatId, voiceBuffer, `🎙️ CR voice announcement (AI clone of Karthik's voice)`);
      }
      sentCount++;
      console.log(`✅ [Telegram Broadcast Delivered] to ${s.name} (Chat ID: ${s.chatId})`);
    } catch (err) {
      console.warn(`[Broadcast Failed for ${s.chatId}]:`, err.message);
    }
  }

  return { total: students.length, sentCount };
}

/** Download a file/voice note from Telegram servers */
export async function downloadTelegramFile(fileId) {
  const getFileUrl = `${TELEGRAM_API_BASE}/getFile?file_id=${fileId}`;
  const res = await fetch(getFileUrl);
  if (!res.ok) throw new Error(`Telegram getFile failed: ${res.statusText}`);
  const data = await res.json();
  if (!data.ok || !data.result?.file_path) {
    throw new Error('Telegram getFile did not return file_path');
  }
  const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${data.result.file_path}`;
  const fileRes = await fetch(downloadUrl);
  if (!fileRes.ok) throw new Error(`Failed to download Telegram media: ${fileRes.statusText}`);
  const arrayBuffer = await fileRes.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), filePath: data.result.file_path };
}

// ───────────────────────── Greeting detection ─────────────────────────

/**
 * Detect if a message is purely a greeting (e.g. "Hi", "Hello", "Hey bro")
 * so the bot gives a friendly instant text reply instead of searching + voice.
 */
export function isPureGreeting(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.toLowerCase().trim().replace(/[!.,?~@#]/g, '');
  if (!clean) return false;

  const exactGreetings = new Set([
    'hi', 'hello', 'hey', 'heyy', 'heyyy', 'hii', 'hiii',
    'hi cr', 'hello cr', 'hey cr', 'hi bro', 'hello bro', 'hey bro',
    'hi karthik', 'hello karthik', 'hey karthik',
    'good morning', 'good afternoon', 'good evening', 'good night',
    'gm', 'ga', 'ge', 'gn',
    'yo', 'sup', 'wassup', 'whatsup', 'whats up',
    'bro', 'cr', 'karthik', 'oye', 'namaste', 'vanakkam', 'hola', 'ola'
  ]);

  if (exactGreetings.has(clean)) return true;

  // Short greeting phrase (<= 3 words) without subject/study keywords
  const words = clean.split(/\s+/);
  const materialKeywords = [
    'pdf', 'note', 'notes', 'unit', 'lab', 'drive', 'exam', 'paper', 'papers',
    'syllabus', 'manual', 'due', 'deadline', 'class', 'shift', 'room', 'schedule',
    'submission', 'record', 'assignment', 'verilog', 'vlsi', 'circuit', 'breaker',
    'relays', 'fuses', 'psp', 'test', 'mid', 'link'
  ];

  const hasMaterialWord = words.some((w) => materialKeywords.some((mk) => w.includes(mk)));
  if (!hasMaterialWord && words.length <= 3) {
    for (const g of exactGreetings) {
      if (clean.startsWith(g) || clean.endsWith(g)) return true;
    }
  }

  return false;
}

// ───────────────────────── Request handling ─────────────────────────

/**
 * Process an incoming classmate request end-to-end:
 * 1. Greeting → instant text reply, no voice
 * 2. Deadline/schedule question → strict lookup from saved announcements
 * 3. Drive catalog match → link(s) + voice note
 * 4. Laptop materials fallback
 * 5. Nothing found → helpful reply, NO voice note
 * The text reply is sent first; the voice note follows once it is ready.
 */
export async function processClassmateTelegramMessage(chatId, senderName, incomingMessage) {
  console.log(`\n======================================================`);
  console.log(`📥 [Telegram CR Bot] New Request from ${senderName}: "${incomingMessage}"`);
  console.log(`======================================================`);

  const name = md(senderName);

  // Step 0: Pure greeting
  if (isPureGreeting(incomingMessage)) {
    console.log(`👋 [Greeting Detected] Instant text greeting for ${senderName}, no audio.`);
    const greetingText =
      `Hey *${name}*! 👋 StandIn here, covering for Karthik.\n\n` +
      `Ask me for notes, papers or deadlines, for example:\n${examplesText()}\n\n` +
      `You can also send a voice message.`;

    await sendTelegramTextMessage(chatId, greetingText);
    return {
      success: true,
      senderName,
      incomingMessage,
      matchedTitle: 'Greeting',
      matchedUrl: null,
      replyScript: '',
      replyMessage: greetingText,
      voiceNoteUrl: null
    };
  }

  let replyScript = '';
  let replyMessage = '';
  let matchedTitle = '';
  let matchedUrl = '';
  let localPdfPath = null;
  let skipVoice = false; // true for replies where a voice note adds nothing

  if (isDeadlineOrScheduleQuery(incomingMessage)) {
    // Step 1: Deadline / schedule question (answered only from saved announcements)
    console.log(`📢 [Schedule Query Detected] Looking up official announcements...`);
    const scheduleResult = answerScheduleQuery(incomingMessage);
    replyMessage = `Hey *${name}*! 👋\n\n${scheduleResult.answer}`;
    replyScript = scheduleResult.voiceScript;
    matchedTitle = scheduleResult.found ? 'Official Class Announcement' : 'Class Schedule Status';
    if (!scheduleResult.found) skipVoice = true; // "I don't know" doesn't need audio
  } else {
    // Step 2: Search the 6th Sem Google Drive catalog
    const driveMatch = searchDriveCatalog(incomingMessage);

    if (driveMatch) {
      console.log(`🔍 [Drive Match] Found: "${driveMatch.title}" (${driveMatch.subjectName})`);
      matchedTitle = driveMatch.title;
      matchedUrl = driveMatch.url;

      replyScript =
        `Hey ${senderName}, this is an AI clone of Karthik's voice. ` +
        `The closest match I found is ${matchedTitle}. I've sent you the Google Drive link. Best of luck studying!`;

      replyMessage =
        `Hey *${name}*! 👋\n\n` +
        `Closest match from our *6th Sem EEE Drive*:\n\n` +
        `📄 *${md(driveMatch.title)}*\n` +
        `🔗 [Open in Google Drive](${driveMatch.url})\n\n` +
        (driveMatch.parentFolderUrl && driveMatch.parentFolderUrl !== driveMatch.url
          ? `📁 *Subject folder:* [Open ${md(driveMatch.subjectName)}](${driveMatch.parentFolderUrl})\n\n`
          : '') +
        `Not the one you wanted? Tell me the subject and unit. 🎙️ Voice note below (AI clone of Karthik's voice).`;
    } else {
      // Step 3: Laptop materials fallback
      const localMatch = searchLaptopMaterials(incomingMessage);
      if (localMatch) {
        console.log(`🔍 [Laptop Match] Found: "${localMatch.fileName}"`);
        matchedTitle = localMatch.topic;
        localPdfPath = localMatch.filePath;

        replyScript =
          `Hey ${senderName}, this is an AI clone of Karthik's voice. ` +
          `I found the ${matchedTitle} notes for you. The PDF is attached. All the best!`;

        replyMessage =
          `Hey *${name}*! 👋\n\n` +
          `Found this for you:\n📄 *${md(localMatch.fileName)}*\n\n` +
          `🎙️ Voice note below (AI clone of Karthik's voice).`;
      } else {
        // Step 4: Nothing matched. Helpful text only, no ElevenLabs call.
        skipVoice = true;
        matchedTitle = 'No match';
        matchedUrl = DRIVE_HUB_URL;

        replyMessage =
          `Hey *${name}*! 👋 I couldn't find that one.\n\n` +
          (DRIVE_HUB_URL ? `📁 [Browse the full 6th Sem Drive](${DRIVE_HUB_URL})\n\n` : '') +
          `Try asking with a subject and unit, for example:\n${examplesText()}\n\n` +
          `Still stuck? Message Karthik directly.`;
      }
    }
  }

  // A. Text first, so the student gets an answer immediately
  await sendTelegramTextMessage(chatId, replyMessage).catch((e) =>
    console.error('[Telegram Send Text Error]:', e.message)
  );

  // B. Attach the laptop PDF if there is one
  if (localPdfPath && fs.existsSync(localPdfPath)) {
    console.log(`📎 [Telegram Send] Attaching laptop PDF: ${matchedTitle}...`);
    await sendTelegramDocument(chatId, localPdfPath, path.basename(localPdfPath), `📄 ${matchedTitle}`).catch((e) =>
      console.error('[Telegram Send Doc Error]:', e.message)
    );
  }

  // C. Voice note in Karthik's cloned voice (skipped for fallbacks and over-cap users)
  let voiceNoteUrl = null;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'PIzF7N4AZiqRy5BOSpFC';
  const hasKey = process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY !== 'your_elevenlabs_api_key_here';

  if (!skipVoice && replyScript && hasKey && canUseVoice(chatId)) {
    try {
      console.log(`🎙️ [ElevenLabs TTS] Generating cloned voice note for ${senderName}...`);
      const ttsResult = await synthesizeSpeech(replyScript, voiceId);
      voiceNoteUrl = ttsResult.url;
      if (ttsResult.audioBuffer && ttsResult.audioBuffer.length > 0) {
        console.log(`📤 [Telegram Send] Delivering cloned voice note to ${senderName}...`);
        await sendTelegramVoiceNote(
          chatId,
          ttsResult.audioBuffer,
          `🎙️ AI clone of Karthik's voice (ElevenLabs)`
        ).catch((e) => console.error('[Telegram Send Voice Error]:', e.message));
      }
    } catch (ttsErr) {
      console.warn(`[ElevenLabs Warning]:`, ttsErr.message);
    }
  }

  console.log(`✅ [Telegram CR Bot] Response delivered to ${senderName}\n`);

  return {
    success: true,
    senderName,
    incomingMessage,
    matchedTitle,
    matchedUrl,
    replyScript,
    replyMessage,
    voiceNoteUrl
  };
}

// ───────────────────────── Message router ─────────────────────────

async function handleMessage(message) {
  const chatId = message.chat.id;
  const senderName = message.from?.first_name || message.from?.username || 'Classmate';
  const name = md(senderName);
  const text = message.text ? message.text.trim() : null;
  const voice = message.voice || message.audio;

  // One-time setup helper: only answers while CR_CHAT_ID is not configured.
  if (text === '/whoami' && !CR_CHAT_ID) {
    await sendTelegramTextMessage(chatId, `Your chat ID is ${chatId}. Put it in .env as CR_CHAT_ID and restart.`);
    return;
  }

  // The CR is always authorized (by ID, never by name)
  if (isCR(chatId)) authorizeStudent(chatId, senderName);

  // 1. Passcode: the WHOLE message must be the code (or "/join CODE")
  if (text && CLASS_PASSCODE) {
    const m = text.match(/^(?:\/join(?:@\w+)?\s+)?([A-Za-z0-9]+)$/);
    if (m && m[1].toUpperCase() === CLASS_PASSCODE) {
      authorizeStudent(chatId, senderName);
      await sendTelegramTextMessage(
        chatId,
        `✅ You're in, *${name}*! Ask me for notes, papers or deadlines, for example:\n${examplesText()}`
      );
      return;
    }
  }

  // 2. Gate for people who haven't entered the passcode. Never reveals the code.
  if (!isStudentAuthorized(chatId)) {
    await sendTelegramTextMessage(
      chatId,
      `🔒 Hey *${name}*! StandIn is private to our 6th Sem EEE class.\n\n` +
        `Send the class passcode to unlock it. Ask Karthik if you don't have it.`
    );
    return;
  }

  // 3. Incoming voice note from a student
  if (voice) {
    if (tooFast(chatId)) return;
    console.log(`🎙️ [Incoming Voice Note] Received from ${senderName} (duration: ${voice.duration || '?'}s)...`);
    await sendTelegramTextMessage(chatId, `🎙️ Got your voice note, transcribing...`);

    try {
      const { buffer, filePath } = await downloadTelegramFile(voice.file_id);
      const mimeType =
        voice.mime_type || (filePath.endsWith('.oga') || filePath.endsWith('.ogg') ? 'audio/ogg' : 'audio/mpeg');
      const transcribedText = await transcribeAudio(buffer, mimeType);

      if (!transcribedText || transcribedText.length === 0) {
        await sendTelegramTextMessage(
          chatId,
          `⚠️ I couldn't make out your voice note. Try again closer to the mic, or type your request.`
        );
        return;
      }

      console.log(`🗣️ [Transcribed Voice] "${transcribedText}" by ${senderName}`);
      await sendTelegramTextMessage(chatId, `🗣️ You said: "${md(transcribedText)}"`);
      await processClassmateTelegramMessage(chatId, senderName, transcribedText);
    } catch (voiceErr) {
      console.error(`[Telegram Voice Processing Error]:`, voiceErr);
      await sendTelegramTextMessage(
        chatId,
        `⚠️ I couldn't transcribe that voice note. You can type your request instead.`
      );
    }
    return;
  }

  // 4. Text commands and questions
  if (!text) return;

  if (/^\/start(@\w+)?(\s|$)/i.test(text)) {
    const welcome = isCR(chatId)
      ? `Hey *${name}*, you're signed in as CR. ✅\n\n` +
        `/announce <message> saves a class notice to memory\n` +
        `/announcements shows the active notices\n\n` +
        `Use the dashboard to preview and send announcements to the class. Classmates just message me normally.`
      : `👋 Hey *${name}*! I'm StandIn, the class rep's AI assistant for 6th Sem EEE.\n\n` +
        `Ask me for notes, papers or deadlines and I'll reply with the Drive link and a short voice note. ` +
        `The voice is an AI clone of Karthik's.\n\n` +
        `Try:\n${examplesText()}\n\n` +
        `You can also send a voice message. If I can't find something, I'll say so, or you can ask Karthik.`;
    await sendTelegramTextMessage(chatId, welcome);
    return;
  }

  if (/^\/announce(@\w+)?(\s|$)/i.test(text)) {
    // CR only
    if (!isCR(chatId)) {
      await sendTelegramTextMessage(chatId, `Only the CR can post announcements.`);
      return;
    }

    const annContent = text.replace(/^\/announce(@\w+)?\s*/i, '').trim();
    if (!annContent) {
      await sendTelegramTextMessage(
        chatId,
        `📢 *Save a class notice:*\n\n` +
          `Type: /announce Tomorrow's lecture is shifted to Room 302 at 10 AM, and the lab report deadline is extended to Monday\n\n` +
          `StandIn will save it to class memory so deadline questions get this answer, and send you a voice version. ` +
          `To send it to the whole class with a preview, use the dashboard.`
      );
      return;
    }

    console.log(`📢 [CR Announcement] Digesting notice by ${senderName}...`);
    const digested = await digestFacultyCircular(annContent, 'CR Notice');
    const finalTitle = digested.cleanTitle || 'CR Notice';
    const finalText = digested.formattedNotice || annContent;

    saveAnnouncement({ title: finalTitle, text: finalText, author: senderName });

    let voiceBuf = null;
    try {
      if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY !== 'your_elevenlabs_api_key_here') {
        const voiceScript = digested.spokenVoiceScript || `Hey guys, this is an AI clone of Karthik's voice with a quick class announcement: ${finalTitle}.`;
        const ttsResult = await synthesizeSpeech(voiceScript, process.env.ELEVENLABS_VOICE_ID || 'PIzF7N4AZiqRy5BOSpFC');
        voiceBuf = ttsResult.audioBuffer;
      }
    } catch (e) {
      console.warn('[Announce Voice Gen Warning]:', e.message);
    }

    await sendTelegramTextMessage(
      chatId,
      `✅ *Saved to class memory.*\n\n` +
        `📌 *${md(finalTitle)}*\n` +
        `${finalText}\n\n` +
        `🕒 ${new Date().toLocaleTimeString()}\n\n` +
        `Students asking about this will now get this verified answer. ` +
        `It has *not* been broadcasted to the whole class yet. Use the dashboard to preview and broadcast it.`
    );
    if (voiceBuf) {
      await sendTelegramVoiceNote(chatId, voiceBuf, `🎙️ Voice preview (AI clone of Karthik's voice)`);
    }
    return;
  }

  if (/^\/announcements(@\w+)?(\s|$)/i.test(text)) {
    const list = getAnnouncements();
    if (!list || list.length === 0) {
      await sendTelegramTextMessage(chatId, `ℹ️ No active class announcements right now.`);
    } else {
      let msg = `📢 *Active class announcements:*\n\n`;
      list.forEach((item, idx) => {
        msg += `${idx + 1}. *${md(item.title)}*\n   ${md(item.rawText)}\n   Posted by ${md(item.author)}\n\n`;
      });
      await sendTelegramTextMessage(chatId, msg);
    }
    return;
  }

  // Everything else: study request or deadline question
  if (!isCR(chatId) && tooFast(chatId)) return;
  await processClassmateTelegramMessage(chatId, senderName, text);
}

// ───────────────────────── Polling ─────────────────────────

/** Long-polling loop. Each message is handled without blocking the next one. */
async function pollTelegramUpdates() {
  if (!isPolling) return;

  try {
    const url = `${TELEGRAM_API_BASE}/getUpdates?offset=${lastUpdateId + 1}&timeout=25`;
    const res = await fetch(url);
    if (!res.ok) {
      await new Promise((r) => setTimeout(r, 3000));
      return pollTelegramUpdates();
    }

    const data = await res.json();
    if (data.ok && Array.isArray(data.result)) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        if (update.message) {
          handleMessage(update.message).catch((e) => console.error('[Message handler error]:', e.message));
        }
      }
    }
  } catch (err) {
    console.warn('[Telegram Polling Notice]:', err.message);
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (isPolling) pollTelegramUpdates();
}

/** Start the Telegram Bot Listener */
export function startTelegramBot() {
  if (!TELEGRAM_TOKEN) {
    console.log('[Telegram Bot] No TELEGRAM_BOT_TOKEN found in .env. Bot listener not started.');
    return;
  }
  if (!CLASS_PASSCODE) {
    console.error('[Telegram Bot] CLASS_PASSCODE is not set in .env. Refusing to start (the gate would be open).');
    return;
  }
  if (!CR_CHAT_ID) {
    console.warn('[Telegram Bot] CR_CHAT_ID is not set. /announce is disabled. Send /whoami to the bot, then add your ID to .env.');
  }
  if (isPolling) {
    console.log('[Telegram Bot] Already running.');
    return;
  }

  isPolling = true;
  console.log(`🤖 [Telegram CR Bot] Starting long-poll listener on @${BOT_USERNAME}...`);
  pollTelegramUpdates();
}

/** Stop the Telegram Bot Listener */
export function stopTelegramBot() {
  isPolling = false;
  console.log('[Telegram Bot] Polling stopped.');
}