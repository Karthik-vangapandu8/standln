import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { synthesizeSpeech, transcribeAudio, getVoices } from './elevenlabs.js';
import { searchLaptopMaterials } from './file_search.js';
import { searchDriveCatalog } from './drive_search.js';
import { startTelegramBot, broadcastAnnouncementToTelegram } from './telegram_bot.js';
import {
  isDeadlineOrScheduleQuery,
  answerScheduleQuery,
  getAnnouncements,
  saveAnnouncement,
  deleteAnnouncement,
  updateAnnouncementStatus
} from './announcements.js';
import { digestFacultyCircular } from './circular_digest.js';

const app = express();
const PORT = process.env.PORT || 3000;
// No cors() — the dashboard is served by the same Express server.
// Binding to 127.0.0.1 means only the local machine can reach the API.
app.use(express.json());
const CACHE_DIR = path.resolve('cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

app.use(express.static('public'));
app.use('/audio', express.static(CACHE_DIR));

// ─── Legacy WhatsApp/meeting pipeline removed — see legacy/ folder ────────────


/**
 * Health check endpoint
 */
app.get('/api/health', async (req, res) => {
  const hasElevenLabsKey = !!process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY !== 'your_elevenlabs_api_key_here';
  
  let ollamaConnected = false;
  let gemmaAvailable = false;
  try {
    const ollamaRes = await fetch(`${process.env.OLLAMA_BASE_URL || 'http://localhost:11434'}/api/tags`);
    if (ollamaRes.ok) {
      ollamaConnected = true;
      const data = await ollamaRes.json();
      const modelName = process.env.OLLAMA_MODEL || 'gemma3:4b';
      gemmaAvailable = (data.models || []).some(m => m.name.includes('gemma'));
    }
  } catch (err) {
    ollamaConnected = false;
  }

  res.json({
    status: 'ok',
    elevenLabsConfigured: hasElevenLabsKey,
    ollamaConnected,
    gemmaAvailable,
    model: process.env.OLLAMA_MODEL || 'gemma3:4b'
  });
});

/**
 * Get sample scenarios
 */
app.get('/api/samples', (req, res) => {
  res.json(SAMPLE_MEETINGS);
});

/**
 * List available voices
 */
app.get('/api/voices', async (req, res) => {
  const voices = await getVoices();
  res.json(voices);
});

// ─── Removed: /api/process-meeting — see legacy/ for old pipeline ────────────


/**
 * Direct TTS endpoint
 */
app.post('/api/speak', async (req, res) => {
  try {
    const { text, voiceId } = req.body;
    if (!text) return res.status(400).json({ error: 'Text is required' });

    const result = await synthesizeSpeech(text, voiceId);
    res.json({ success: true, url: result.url, cached: result.cached });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── Removed: /api/cr-auto-reply, /api/browserbase/* (abandoned WhatsApp pipeline) ───

/**
 * Telegram Bot Status & Simulation Endpoints
 */
app.get('/api/telegram/status', (req, res) => {
  const username = process.env.TELEGRAM_BOT_USERNAME || 'standln_cr_bot';
  res.json({
    configured: !!process.env.TELEGRAM_BOT_TOKEN,
    username,
    botUrl: `https://t.me/${username}`
  });
});
/**
 * Announcements Management Endpoints
 */
app.get('/api/announcements', (req, res) => {
  res.json({ announcements: getAnnouncements() });
});

/**
 * AI Circular Digest Endpoint:
 * Cuts short raw emails/circulars, extracts links, and generates a natural spoken script
 */
app.post('/api/announcements/digest', async (req, res) => {
  try {
    const { text, title = '' } = req.body;
    if (!text) return res.status(400).json({ error: 'Announcement text is required' });
    const digested = await digestFacultyCircular(text, title);
    res.json({ success: true, ...digested });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/announcements', async (req, res) => {
  try {
    let { 
      text, 
      author = 'CR Karthik', 
      title = 'Class Notice', 
      status = 'Active', 
      voiceScript: incomingVoiceScript,
      voiceId = process.env.ELEVENLABS_VOICE_ID || 'PIzF7N4AZiqRy5BOSpFC' 
    } = req.body;
    
    if (!text) return res.status(400).json({ error: 'Announcement text is required' });

    let finalTitle = title;
    let finalText = text;
    let voiceScript = incomingVoiceScript;

    // If text looks like a raw email, has links, or is long and no voiceScript was provided:
    const isRawCircular = text.length > 120 || /inbox|http|<.*@.*>|\d{1,2}:\d{2}\s*(?:am|pm)/i.test(text);
    if (!voiceScript || isRawCircular) {
      const digested = await digestFacultyCircular(text, title);
      if (!finalTitle || finalTitle === 'Class Notice' || finalTitle === 'Class Announcement') {
        finalTitle = digested.cleanTitle;
      }
      finalText = digested.formattedNotice || text;
      voiceScript = voiceScript || digested.spokenVoiceScript;
    }

    if (!voiceScript) {
      voiceScript = `Hey guys, this is an AI clone of Karthik's voice with a quick class announcement: ${finalTitle}. Check the notice board for details!`;
    }

    let voiceNoteUrl = null;
    let voiceAudioBuffer = null;

    try {
      if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY !== 'your_elevenlabs_api_key_here') {
        const tts = await synthesizeSpeech(voiceScript, voiceId);
        voiceNoteUrl = tts.url;
        voiceAudioBuffer = tts.audioBuffer;
      }
    } catch (e) {
      console.warn('[Announce Voice Warning]:', e.message);
    }

    const saved = saveAnnouncement({ 
      title: finalTitle, 
      text: finalText, 
      author, 
      status, 
      voiceUrl: voiceNoteUrl 
    });

    let broadcast = { sentCount: 0, total: 0 };
    if (status === 'Active') {
      try {
        broadcast = await broadcastAnnouncementToTelegram(finalTitle, finalText, voiceAudioBuffer);
      } catch (bcErr) {
        console.warn('[Telegram Broadcast Warning]:', bcErr.message);
      }
    }

    // Extract structured fields for UI preview cards
    const roomMatch = (finalTitle + ' ' + finalText).match(/\b(Room\s*\d+[A-Za-z]?|Hall\s*[A-Za-z\d]+|Lab\s*\d+)\b/i);
    const timeMatch = (finalTitle + ' ' + finalText).match(/\b(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))\b/);
    const dateMatch = (finalTitle + ' ' + finalText).match(/\b(Tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Today|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\b/i);
    const subjectMatch = (finalTitle + ' ' + finalText).match(/\b(VLSI|PSP|PE|Power Systems|Power Electronics|DBMS|ACS|Calculus|Control Systems|LinkedIn|Competition)\b/i);
    const whatChangedMatch = (finalTitle + ' ' + finalText).match(/\b(Shifted|Postponed|Extended|Rescheduled|Cancelled|Due Date|Deadline|Exam|Assignment|Submission|Competition|Challenge|Opportunity)\b/i);

    const subject = subjectMatch ? subjectMatch[0].toUpperCase() : (finalTitle || 'Class Notice');
    const whatChanged = whatChangedMatch ? whatChangedMatch[0] : 'Schedule Update';
    const date = dateMatch ? dateMatch[0] : null;
    const time = timeMatch ? timeMatch[0] : null;
    const room = roomMatch ? roomMatch[0] : null;

    res.json({ 
      success: true, 
      announcement: saved, 
      voiceNoteUrl, 
      voiceScript,
      subject,
      whatChanged,
      date,
      time,
      room,
      broadcast
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/announcements/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const updated = updateAnnouncementStatus(id, status);
    if (!updated) return res.status(404).json({ error: 'Announcement not found' });
    res.json({ success: true, announcement: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/announcements/:id', (req, res) => {
  try {
    const { id } = req.params;
    const ok = deleteAnnouncement(id);
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/telegram/test-dispatch', async (req, res) => {
  try {
    const { senderName = 'Pavan', incomingMessage = 'hi cr send unit 5 circuit breakers' } = req.body;
    const voiceId = req.body.voiceId || process.env.ELEVENLABS_VOICE_ID || 'PIzF7N4AZiqRy5BOSpFC';

    let matchedTopic = '';
    let driveUrl = '';
    let replyScript = '';
    let replyMessage = '';

    // Step 1: Check if schedule or deadline query
    if (isDeadlineOrScheduleQuery(incomingMessage)) {
      const scheduleResult = answerScheduleQuery(incomingMessage);
      matchedTopic = scheduleResult.found ? 'Official Class Announcement' : 'Class Schedule Status';
      replyMessage = `Hey *${senderName}*! 👋\n\n${scheduleResult.answer}`;
      replyScript = scheduleResult.voiceScript;
    } else {
      // Step 2: Search real 6th Sem Google Drive Catalog
      const driveMatch = searchDriveCatalog(incomingMessage);

      if (driveMatch) {
        matchedTopic = driveMatch.title;
        driveUrl = driveMatch.url;
        replyScript = `Hey ${senderName}, this is an AI clone of Karthik's voice with your requested study material. I've sent you the direct Google Drive link for ${matchedTopic}. You have full access right here. Best of luck studying!`;
        replyMessage = `Hey *${senderName}*! 👋\n\nHere is the study material from our *6th Sem EEE Drive*:\n\n📄 *${driveMatch.title}*\n🔗 [Open in Google Drive](${driveMatch.url})\n\n📁 *Subject Folder:* [Open ${driveMatch.subjectName} Drive](${driveMatch.parentFolderUrl})\n\n🎙️ *Voice Note Attached:* (Generated in CR Karthik's cloned voice)\nAll the best for your prep! ⚡📚`;
      } else {
        const foundDoc = searchLaptopMaterials(incomingMessage);
        matchedTopic = foundDoc ? foundDoc.topic : 'Course Study Materials';
        replyScript = `Hey ${senderName}, this is an AI clone of Karthik's voice. I searched my laptop and found the ${matchedTopic} notes for you. Attached the document right here. All the best with your prep!`;
        replyMessage = `Hey *${senderName}*! 👋\n\nI found the notes you asked for on my laptop:\n📄 *${matchedTopic}*\n\n🎙️ *Voice Note Attached:* (Generated in CR Karthik's cloned voice)\nAll the best for your prep! ⚡📚`;
      }
    }

    // Step 3: Synthesize voice note with ElevenLabs Flash v2.5
    let voiceNoteUrl = null;
    try {
      if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY !== 'your_elevenlabs_api_key_here') {
        const ttsRes = await synthesizeSpeech(replyScript, voiceId);
        voiceNoteUrl = ttsRes.url;
      }
    } catch (ttsErr) {
      console.warn('[TTS Warning]:', ttsErr.message);
    }

    res.json({
      success: true,
      senderName,
      incomingMessage,
      matchedTopic,
      driveUrl,
      replyScript,
      replyMessage,
      voiceNoteUrl,
      botUsername: process.env.TELEGRAM_BOT_USERNAME || 'standln_cr_bot',
      botUrl: `https://t.me/${process.env.TELEGRAM_BOT_USERNAME || 'standln_cr_bot'}`
    });
  } catch (err) {
    console.error('Error in test dispatch:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n======================================================`);
  console.log(`🦥 StandIn AI Server running at http://localhost:${PORT}`);
  console.log(`🤖 Local LLM: ${process.env.OLLAMA_MODEL || 'gemma3:4b'} on ${process.env.OLLAMA_BASE_URL || 'http://localhost:11434'}`);
  console.log(`🎙️ ElevenLabs: ${process.env.ELEVENLABS_API_KEY ? 'Configured' : 'Needs key in .env'}`);
  console.log(`✈️ Telegram Bot: https://t.me/${process.env.TELEGRAM_BOT_USERNAME || 'standln_cr_bot'}`);
  console.log(`======================================================\n`);

  // Start autonomous Telegram Bot Listener
  startTelegramBot();
});
