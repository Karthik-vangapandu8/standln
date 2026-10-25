import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { synthesizeSpeech, transcribeAudio, getVoices } from './elevenlabs.js';
import { analyzeMeetingWithGemma } from './gemma.js';
import { sendWhatsAppViaBrowserbase, launchWhatsAppLinkingSession, scanWhatsAppChats } from './browserbase.js';
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

app.use(cors());
app.use(express.json());
const CACHE_DIR = path.resolve('cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

app.use(express.static('public'));
app.use('/audio', express.static(CACHE_DIR));

// Built-in sample scenarios for instant one-click testing
const SAMPLE_MEETINGS = {
  dc_machines: {
    title: "EE 204: Performance of DC Machines & Transformers",
    category: "Electrical Engineering",
    transcript: `Professor Rao: Good morning class. Today we're diving into the performance characteristics of DC machines and single-phase transformers.
First, attendance check:
Karthik Vangapandu? Karthik, are you on the call?
(Brief pause)
Okay, moving ahead. Remember: in a DC motor, back-EMF is not just a passive voltage—it is the fundamental self-regulating governor of the machine. The formula Eb = (P * Phi * Z * N) / (60 * A) dictates that if the mechanical load increases, the motor momentarily slows down, Eb drops, and armature current Ia rises automatically to produce the required electromagnetic torque!
Now for transformers: remember our open-circuit and short-circuit tests. Maximum efficiency occurs strictly when variable copper losses equal constant core iron losses!
Important exam announcement: question two on next Tuesday's midterm will specifically test transformer efficiency calculations. Also, submit your DC machine speed control lab report by Friday midnight on the portal.`
  },
  college_class: {
    title: "Calculus II - Morning Lecture & Roll Call",
    category: "Mathematics",
    transcript: `Professor Miller: Alright everyone, quiet down, let's start today's lecture. First, roll call for attendance. 
Sarah Jenkins? Present. 
David Chen? Present. 
Karthik Vangapandu? Karthik, are you here today?
(Silence for 2 seconds)
Professor Miller: Moving on... Alex Rivera? Present.
Okay, before we get into integration by parts, an important announcement: Quiz number three, which was scheduled for this Wednesday, is officially postponed to next Monday because of the campus technical downtime. Also, make sure to submit homework assignment four on the portal by Friday midnight. No extensions on that one.`
  },
  engineering_standup: {
    title: "Sprint 42 Daily Engineering Standup",
    category: "Software Engineering",
    transcript: `Sarah (Product): Good morning team. Let's do a quick round for today's standup. Marcus, you go first.
Marcus: Yesterday I finished the API route refactoring. Today I'm reviewing pull requests. No blockers.
Sarah: Awesome. Karthik, you're up next. How is the database migration to PostgreSQL going? Are we on track for staging release today?
(Short pause)
Sarah: Let's follow up on Slack if audio isn't working. Next is Elena.
Elena: I'm finishing the CSS layout for the checkout page. We should be ready by 3 PM.`
  }
};

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

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 35 * 1024 * 1024 } // 35 MB max
});

const multiUpload = upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'pdf', maxCount: 1 }
]);

/**
 * Extract text from PDF using PyMuPDF (fitz)
 */
async function extractTextFromPdfBuffer(pdfBuffer) {
  const tempPath = path.join(CACHE_DIR, `temp_${Date.now()}_slides.pdf`);
  try {
    fs.writeFileSync(tempPath, pdfBuffer);
    const { stdout } = await execFileAsync('python3', [path.resolve('server/pdf_extractor.py'), tempPath]);
    const result = JSON.parse(stdout);
    if (result.success) {
      console.log(`[PyMuPDF] Successfully extracted ${result.totalPages} pages from PDF handout.`);
      return result.extractedText || '';
    } else {
      console.warn('[PyMuPDF extraction failed]:', result.error);
      return '';
    }
  } catch (err) {
    console.error('[PyMuPDF Error]:', err.message);
    return '';
  } finally {
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (e) {}
    }
  }
}

/**
 * Process a meeting (Audio/Text + optional PDF handout -> Gemma -> ElevenLabs Audio)
 */
app.post('/api/process-meeting', multiUpload, async (req, res) => {
  try {
    let transcript = req.body.transcript || '';
    const userName = req.body.userName || 'Karthik';
    const voiceId = req.body.voiceId || process.env.ELEVENLABS_VOICE_ID;
    let pdfContext = '';

    // Step 1: If PDF handout/slides uploaded, extract with PyMuPDF
    if (req.files && req.files['pdf'] && req.files['pdf'][0]) {
      const pdfFile = req.files['pdf'][0];
      console.log(`[PyMuPDF] Processing PDF handout: ${pdfFile.originalname} (${pdfFile.size} bytes)`);
      pdfContext = await extractTextFromPdfBuffer(pdfFile.buffer);
    }

    // Step 2: If audio file uploaded, transcribe with ElevenLabs Scribe
    if (req.files && req.files['audio'] && req.files['audio'][0]) {
      const audioFile = req.files['audio'][0];
      console.log(`[Process] Received audio upload (${audioFile.size} bytes, type: ${audioFile.mimetype})`);
      try {
        transcript = await transcribeAudio(audioFile.buffer, audioFile.mimetype);
      } catch (sttError) {
        console.warn(`[Process STT warning]: ${sttError.message}. Using fallback sample transcript.`);
        transcript = SAMPLE_MEETINGS.dc_machines.transcript;
      }
    }

    if (!transcript || transcript.trim().length === 0) {
      return res.status(400).json({ error: 'Please provide either an audio recording, a transcript, or choose a sample scenario.' });
    }

    // Step 3: Analyze meeting using local open-weight Gemma model with PDF context
    const gemmaAnalysis = await analyzeMeetingWithGemma(transcript, userName, pdfContext);

    // Step 3: Synthesize ElevenLabs spoken debrief audio
    let debriefAudio = null;
    let surrogateAudio = null;
    let crBroadcastAudio = null;
    let elevenLabsError = null;

    try {
      if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY !== 'your_elevenlabs_api_key_here') {
        // Generate main debrief voice
        const debriefResult = await synthesizeSpeech(gemmaAnalysis.spokendebriefScript, voiceId);
        debriefAudio = debriefResult.url;

        // If user was called, generate the surrogate reply audio too!
        if (gemmaAnalysis.attendanceOrNameCalled && gemmaAnalysis.surrogateAutoReply && gemmaAnalysis.surrogateAutoReply !== 'None needed.') {
          const surrogateResult = await synthesizeSpeech(gemmaAnalysis.surrogateAutoReply, voiceId);
          surrogateAudio = surrogateResult.url;
        }

        // Generate Class Representative WhatsApp Voice Note in cloned voice
        if (gemmaAnalysis.crBroadcast && gemmaAnalysis.crBroadcast.voiceScript) {
          try {
            const crResult = await synthesizeSpeech(gemmaAnalysis.crBroadcast.voiceScript, voiceId);
            crBroadcastAudio = crResult.url;
          } catch (crErr) {
            console.warn('[CR Voice Note Warning]:', crErr.message);
          }
        }
      } else {
        elevenLabsError = 'ElevenLabs API key is missing. Add it to .env to hear real voice generation!';
      }
    } catch (ttsErr) {
      console.error('[TTS Error]:', ttsErr.message);
      elevenLabsError = ttsErr.message;
    }

    res.json({
      success: true,
      userName,
      transcript,
      analysis: gemmaAnalysis,
      audio: {
        debriefUrl: debriefAudio,
        surrogateUrl: surrogateAudio,
        crBroadcastUrl: crBroadcastAudio,
        error: elevenLabsError
      }
    });

  } catch (error) {
    console.error('Error processing meeting:', error);
    res.status(500).json({ error: error.message || 'Failed to process meeting' });
  }
});

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

/**
 * Autonomous Class Representative Auto-Reply (Browserbase + Gemma + ElevenLabs)
 * Automatically replies to classmate WhatsApp DMs asking for notes, formulas, or deadlines!
 */
app.post('/api/cr-auto-reply', async (req, res) => {
  try {
    const { senderName = 'Pavan', incomingMessage = 'hi cr send the notes of ac machines' } = req.body;
    const userName = req.body.userName || 'Karthik';
    const voiceId = req.body.voiceId || process.env.ELEVENLABS_VOICE_ID;

    console.log(`[Auto-CR] Received DM from ${senderName}: "${incomingMessage}"`);

    // Step 1: Search for requested document/PDF on local laptop
    const foundDoc = searchLaptopMaterials(incomingMessage);
    const matchedTopic = foundDoc ? foundDoc.topic : 'Course Study Materials';
    const pdfAttached = foundDoc ? foundDoc.fileName : null;
    const pdfPath = foundDoc ? foundDoc.filePath : null;

    console.log(`[Auto-CR] Laptop File Search Result:`, foundDoc ? `Found ${foundDoc.fileName} (${foundDoc.fileSize} bytes)` : 'No exact match, using default course notes');

    // Step 2: Formulate personalized voice response in Karthik's cloned voice
    const replyScript = `Hey ${senderName}! Karthik here. I searched my laptop and found the ${matchedTopic} notes for you. Attached the PDF right here. All the best with your prep!`;
    const replyMessage = `Hey ${senderName}! 👋\n\nI found the notes you asked for on my laptop:\n📄 *${pdfAttached || matchedTopic}*\n\n🎙️ *Voice Note Attached:* (Sent in CR Karthik's cloned voice)\nAll the best with your prep! ⚡📚`;

    // Step 3: Synthesize voice note in Karthik's cloned voice using ElevenLabs Flash v2.5
    let voiceNoteUrl = null;
    try {
      if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY !== 'your_elevenlabs_api_key_here') {
        const ttsRes = await synthesizeSpeech(replyScript, voiceId);
        voiceNoteUrl = ttsRes.url;
      }
    } catch (ttsErr) {
      console.warn('[Auto-CR TTS Warning]:', ttsErr.message);
    }

    // Step 4: Dispatch to WhatsApp Web in Browserbase Cloud
    let browserbaseResult = null;
    try {
      if (process.env.BROWSERBASE_API_KEY) {
        browserbaseResult = await sendWhatsAppViaBrowserbase({
          recipient: senderName,
          message: replyMessage,
          voiceNoteUrl,
          pdfAttached,
          pdfPath
        });
      }
    } catch (bbErr) {
      console.warn('[Browserbase Warning]:', bbErr.message);
    }

    res.json({
      success: true,
      senderName,
      incomingMessage,
      matchedTopic,
      pdfAttached,
      pdfPath,
      replyScript,
      replyMessage,
      voiceNoteUrl,
      browserbase: browserbaseResult
    });
  } catch (err) {
    console.error('Error in CR auto-reply:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Scan WhatsApp Web chats and contacts via Browserbase
 */
app.get('/api/browserbase/scan-chats', async (req, res) => {
  try {
    const result = await scanWhatsAppChats();
    res.json(result);
  } catch (err) {
    console.error('Error scanning WhatsApp chats:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Launch WhatsApp Web QR Code Linking Session in Browserbase
 */
app.post('/api/browserbase/link-device', async (req, res) => {
  try {
    const result = await launchWhatsAppLinkingSession();
    res.json(result);
  } catch (err) {
    console.error('Error launching linking session:', err);
    res.status(500).json({ error: err.message });
  }
});

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

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🦥 StandIn AI Server running at http://localhost:${PORT}`);
  console.log(`🤖 Local LLM: ${process.env.OLLAMA_MODEL || 'gemma3:4b'} on ${process.env.OLLAMA_BASE_URL || 'http://localhost:11434'}`);
  console.log(`🎙️ ElevenLabs: ${process.env.ELEVENLABS_API_KEY ? 'Configured' : 'Needs key in .env'}`);
  console.log(`✈️ Telegram Bot: https://t.me/${process.env.TELEGRAM_BOT_USERNAME || 'standln_cr_bot'}`);
  console.log(`======================================================\n`);

  // Start autonomous Telegram Bot Listener
  startTelegramBot();
});
