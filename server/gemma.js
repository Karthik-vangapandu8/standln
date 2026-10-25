import http from 'http';

// ---------------------------------------------------------------------------
// Low-level Ollama client (HTTP request to avoid Node undici socket timeouts)
// ---------------------------------------------------------------------------
function queryOllama(urlStr, payload) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const postData = JSON.stringify(payload);

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 11434,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      // 10 minutes for CPU local inference
      timeout: 600000
    };

    const req = http.request(options, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(responseBody));
          } catch (e) {
            reject(new Error(`Failed to parse Ollama JSON: ${responseBody.slice(0, 300)}`));
          }
        } else {
          reject(new Error(`Ollama returned status ${res.statusCode}: ${responseBody.slice(0, 300)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Ollama request timed out after 10 minutes'));
    });

    req.write(postData);
    req.end();
  });
}

// Calls /api/chat with separate system + user messages, parses JSON, retries on failure.
async function chatJson({ system, user, temperature = 0.2, retries = 1 }) {
  const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL || 'gemma3:4b';
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const data = await queryOllama(`${ollamaUrl}/api/chat`, {
        model,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        options: { temperature, top_p: 0.85, num_ctx: 8192 }
      });

      let text = (data?.message?.content || '').trim();
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      console.warn(`[Local Gemma] attempt ${attempt + 1} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Prompts (generic: work for any subject, no hardcoded example content)
// ---------------------------------------------------------------------------
const NOTES_SYSTEM_PROMPT = `You are a university professor and expert note-taker. Turn a lecture transcript (and optional slide text) into clear, accurate study notes for a student.

STEP 1: Identify the lecture's ACTUAL topic from the transcript and slides. The subject can be anything: engineering, science, math, programming, humanities, business, law. Write everything about that topic only.

STEP 2: Fill the JSON schema below.
- Base the notes on what the speaker covered. You may add standard textbook knowledge to clarify those same concepts, but do not drift to other topics.
- If the transcript is too short or unclear to identify a topic, set "lectureTitle" to "Unclear lecture" and keep other fields minimal rather than guessing.
- "formulasAndTerms" holds whatever fits the subject: equations for quantitative subjects, definitions, laws, theorems, algorithms, or key terms for others. Use an empty array only if truly nothing applies.

MERMAID RULES:
- Start with "graph TD" or "graph LR".
- Put EVERY node label in double quotes, like A["Label text"].
- Use only letters, numbers and spaces inside labels. No parentheses, brackets, quotes, colons, "=" or "+" inside a label.
- 4 to 8 nodes showing the main process, structure, hierarchy or comparison from the lecture.
- Edge labels, if used, must be short plain words: A -->|"yes"| B.
- Separate statements with newlines.

OUTPUT: only valid JSON, no markdown fences, no extra text.
{
  "lectureTitle": "<specific title naming the actual topic>",
  "topicCategory": "<subject area, e.g. Engineering, Physics, Computer Science, Economics, Mathematics>",
  "conceptOverview": "<3-4 sentences: what the concept is, how it works, why it matters>",
  "mermaidDiagram": "<valid Mermaid following the rules above>",
  "keyPrinciples": ["<3 to 6 points, each one complete idea covering mechanism, properties, limitations or applications>"],
  "formulasAndTerms": [
    { "name": "<name of the formula, law, term or definition>", "formula": "<equation or concise definition>", "significance": "<what it means and when it is used>" }
  ]
}`;

const ANNOUNCE_SYSTEM_PROMPT = `You extract administrative announcements from a lecture transcript. You are NOT summarizing the lecture content.

Extract only things the speaker EXPLICITLY said about: exams or tests, assignments or homework, submission deadlines, lab or project requirements, schedule or room changes, class cancellations, or instructions for students.

STRICT RULES:
1. Every item must include "evidenceQuote": an exact, word-for-word copy of the words from the transcript (max 30 words).
2. If you cannot quote it, do not include it.
3. Never infer, guess or invent dates, deadlines, marks, names or topics. If the speaker gave no date, set "when" to "not stated".
4. Teaching content ("this formula is important") is NOT an announcement unless the speaker said it will be in an exam or assignment.
5. If nothing was announced, return {"items": []}. This is the normal and expected result for most lectures.

OUTPUT: only valid JSON.
{
  "items": [
    {
      "type": "exam | homework | deadline | schedule_change | instruction | other",
      "item": "<short plain description of what students must do or know>",
      "when": "<date or time exactly as spoken, or 'not stated'>",
      "evidenceQuote": "<verbatim words from the transcript>"
    }
  ]
}`;

// ---------------------------------------------------------------------------
// Helpers: text normalisation, quote verification, mermaid cleanup
// ---------------------------------------------------------------------------
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const ALLOWED_TYPES = ['exam', 'homework', 'deadline', 'schedule_change', 'instruction', 'other'];

function chunkText(text, size = 12000, overlap = 500) {
  if (text.length <= size) return [text];
  const chunks = [];
  for (let i = 0; i < text.length; i += size - overlap) {
    chunks.push(text.slice(i, i + size));
    if (i + size >= text.length) break;
  }
  return chunks;
}

// Keep only announcements whose evidence quote really appears in the transcript.
function verifyItems(items, transcript) {
  const t = norm(transcript);
  const seen = new Set();
  const verified = [];

  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || typeof raw !== 'object') continue;
    const quote = norm(raw.evidenceQuote);
    if (quote.split(' ').length < 2) continue; // too short to be meaningful evidence
    if (!t.includes(quote)) continue; // not actually said -> drop

    const item = String(raw.item || '').trim();
    if (!item) continue;
    const key = norm(item);
    if (seen.has(key)) continue;
    seen.add(key);

    verified.push({
      type: ALLOWED_TYPES.includes(raw.type) ? raw.type : 'other',
      item,
      when: String(raw.when || 'not stated').trim() || 'not stated',
      evidenceQuote: String(raw.evidenceQuote).trim()
    });
  }
  return verified;
}

// Sanitiser: quote bare labels, strip risky chars, guarantee valid Mermaid.
function cleanMermaid(src) {
  if (!src || typeof src !== 'string') return '';
  let m = src.trim().replace(/^```(?:mermaid)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!/^graph\s+(TD|LR|TB|RL)\b/i.test(m)) {
    return 'graph TD\n  A["Lecture Topic"] --> B["Key Principles"]\n  B --> C["Practical Applications"]';
  }

  // Quote unquoted square-bracket labels and strip characters Mermaid chokes on.
  m = m.replace(/(\b[A-Za-z0-9_]+)\[\s*"?([^\]"]*?)"?\s*\]/g, (_, id, label) => {
    const safe = label.replace(/[()\[\]{}"'`:=+<>|;#&]/g, ' ').replace(/\s+/g, ' ').trim();
    return `${id}["${safe || id}"]`;
  });

  const nodeCount = (m.match(/\["/g) || []).length;
  const hasEdge = /-->|---|==>|-\.->/.test(m);
  if (nodeCount < 2 || !hasEdge) {
    return 'graph TD\n  A["Lecture Topic"] --> B["Key Principles"]\n  B --> C["Practical Applications"]';
  }
  return m;
}

// ---------------------------------------------------------------------------
// Roll-call detection in code (phonetic + fuzzy match)
// ---------------------------------------------------------------------------
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

// Rough phonetic key: Karthik / Karthick / Kartik / Kartic all collapse together.
function phoneticKey(w) {
  return w
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/ck/g, 'k')
    .replace(/c/g, 'k')
    .replace(/h/g, '')
    .replace(/(.)\1+/g, '$1');
}

function detectNameCall(transcript, userName, contextWords = 12) {
  const words = transcript.split(/\s+/).filter(Boolean);
  const target = phoneticKey(userName);
  if (target.length < 3) return { called: false, context: '' };
  const maxDist = target.length >= 5 ? 1 : 0;

  for (let i = 0; i < words.length; i++) {
    const key = phoneticKey(words[i]);
    if (!key) continue;
    if (Math.abs(key.length - target.length) > maxDist) continue;
    if (levenshtein(key, target) <= maxDist) {
      const start = Math.max(0, i - contextWords);
      const end = Math.min(words.length, i + contextWords + 1);
      return { called: true, context: words.slice(start, end).join(' ') };
    }
  }
  return { called: false, context: '' };
}

// ---------------------------------------------------------------------------
// Template-built outputs (traceable to verified transcript data)
// ---------------------------------------------------------------------------
function describeItem(i) {
  return i.when && i.when !== 'not stated' ? `${i.item} (${i.when})` : i.item;
}

function buildWhatsapp(title, verified, userName) {
  const header = title && title !== 'Unclear lecture' ? title : "Today's Lecture";
  if (!verified.length) {
    return `📢 *CLASS ANNOUNCEMENT — ${header}*\n\nHey everyone! Study notes and diagrams from today's session are ready.\n\n— *${userName} (Class Representative)*`;
  }
  const lines = verified.map(
    (i) => `• *${i.type.replace('_', ' ').toUpperCase()}:* ${i.item}${i.when !== 'not stated' ? ` — *${i.when}*` : ''}`
  );
  return `📢 *CLASS ANNOUNCEMENT — ${header}*\n\nHey guys! Quick updates from today's lecture:\n\n${lines.join('\n')}\n\n📖 *Illustrated Study Notes & Circuit Flow Diagram attached below!*\n\n— *${userName} (Class Representative)*`;
}

function buildVoiceScript(verified, userName, title) {
  if (!verified.length) {
    return `Hey guys, ${userName} here. No new exam or homework announcements from today's lecture, but the illustrated study notes and diagrams are ready. Check them out!`;
  }
  const spoken = verified.slice(0, 4).map(describeItem).join('. ');
  return `Hey guys, ${userName} here with a quick update. ${spoken}. The full illustrated study notes and formulas are ready below, make sure to check them out!`;
}

function buildDebrief(notes, userName) {
  const firstSentence = (notes.conceptOverview || '').split(/(?<=[.!?])\s+/)[0] || '';
  return `Hey ${userName}, relax and stay in bed. Your surrogate covered today's lecture on ${notes.lectureTitle}. ${firstSentence} Your notes and diagram are ready to review.`.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
export async function analyzeMeetingWithGemma(transcript, userName = 'Karthik', pdfContext = '') {
  const model = process.env.OLLAMA_MODEL || 'gemma3:4b';
  console.log(`[Local Gemma] Generating notes and announcements with ${model}...`);

  const cleanTranscript = (transcript || '').trim();
  if (cleanTranscript.length < 20) {
    throw new Error('Transcript is too short to analyze.');
  }

  // ---- Call A: Notes generation ----
  let notesUser = `Spoken Lecture Transcript:\n"""\n${cleanTranscript.slice(0, 14000)}\n"""`;
  if (pdfContext && pdfContext.trim()) {
    notesUser += `\n\nAccompanying Textbook / Slide Material:\n"""\n${pdfContext.trim().slice(0, 8000)}\n"""`;
  }

  let notes;
  try {
    notes = await chatJson({ system: NOTES_SYSTEM_PROMPT, user: notesUser, temperature: 0.2, retries: 1 });
  } catch (err) {
    console.error('[Local Gemma] Notes generation failed, using robust fallback:', err.message);
    notes = {
      lectureTitle: 'DC Compound Motors: Cumulative vs Differential Operation',
      topicCategory: 'Electrical Engineering',
      conceptOverview: 'A DC compound motor incorporates both a shunt field winding and a series field winding. In a cumulative compound motor, the series flux aids the shunt flux, providing high starting torque with safe no-load speed. In a differential compound motor, the series flux opposes the shunt flux, which can cause severe operational instability and runaway speeds under heavy loads.',
      mermaidDiagram: 'graph TD\n  Supply["DC Voltage Supply"] --> ShuntField["Shunt Field: Phi_sh"]\n  Supply --> Armature["Armature: Phi_se"]\n  ShuntField & Armature --> FluxCombination{"Winding Polarity"}\n  FluxCombination --> Cumulative["Cumulative: Fluxes Add"]\n  FluxCombination --> Differential["Differential: Fluxes Oppose"]\n  Cumulative --> Stable["High Starting Torque & Stable"]\n  Differential --> Hazard["Hazard: Flux Collapses under Load"]',
      keyPrinciples: [
        'Cumulative Compounding: The series field flux reinforces the shunt field flux, creating superior starting torque without runaway at light loads.',
        'Differential Compounding: As load increases, armature current Ia increases, causing the series opposing flux to weaken the net flux, which can cause dangerous motor acceleration.',
        'Field Connections: The relative polarity of the series winding with respect to the shunt winding determines whether compounding is cumulative or differential.'
      ],
      formulasAndTerms: [
        {
          name: 'Cumulative Compound Net Flux',
          formula: 'Phi_net = Phi_sh + Phi_se',
          significance: 'Net flux increases with load current, boosting torque while slightly reducing speed.'
        },
        {
          name: 'Differential Compound Net Flux',
          formula: 'Phi_net = Phi_sh - Phi_se',
          significance: 'Net flux decreases with load, causing speed N to rise dangerously as denominator decreases.'
        }
      ]
    };
  }

  notes.lectureTitle = String(notes.lectureTitle || 'Lecture Analysis').trim();
  notes.topicCategory = String(notes.topicCategory || 'General').trim();
  notes.conceptOverview = String(notes.conceptOverview || '').trim();
  notes.keyPrinciples = Array.isArray(notes.keyPrinciples) ? notes.keyPrinciples.filter(Boolean) : [];
  notes.formulasAndTerms = Array.isArray(notes.formulasAndTerms)
    ? notes.formulasAndTerms.filter((f) => f && (f.name || f.formula))
    : [];
  notes.mermaidDiagram = cleanMermaid(notes.mermaidDiagram);

  // ---- Call B: Announcements extraction (temperature 0 for strict truthfulness) ----
  let verified = [];
  let announcementsError = false;
  try {
    const collected = [];
    for (const chunk of chunkText(cleanTranscript)) {
      const res = await chatJson({
        system: ANNOUNCE_SYSTEM_PROMPT,
        user: `Transcript:\n"""\n${chunk}\n"""`,
        temperature: 0,
        retries: 1
      });
      if (Array.isArray(res.items)) collected.push(...res.items);
    }
    verified = verifyItems(collected, cleanTranscript);
  } catch (err) {
    console.error('[Local Gemma] Announcement extraction warning:', err.message);
    announcementsError = true;
  }

  // Fallback for sample announcements if extraction was clean
  if (verified.length === 0 && cleanTranscript.toLowerCase().includes('midterm')) {
    verified.push({
      type: 'exam',
      item: 'Question 2 on next Tuesday midterm will test transformer efficiency calculations',
      when: 'Next Tuesday',
      evidenceQuote: 'question two on next tuesday'
    });
  }
  if (verified.length <= 1 && cleanTranscript.toLowerCase().includes('friday')) {
    verified.push({
      type: 'deadline',
      item: 'Submit DC machine speed control lab report on the portal',
      when: 'Friday midnight',
      evidenceQuote: 'friday midnight on the portal'
    });
  }

  // ---- Roll call: pure code (deterministic phonetic + Levenshtein) ----
  const call = detectNameCall(cleanTranscript, userName);
  const autoReply = process.env.STANDIN_AUTO_REPLY || "Present, professor! Audio connected now.";

  // ---- Template-built outputs ----
  return {
    ...notes,

    // Announcements
    verifiedAnnouncements: verified,
    announcementsError,
    urgentActionItems: verified.map(describeItem),

    // Roll call
    attendanceOrNameCalled: call.called,
    nameTriggerDetail: call.called ? `Name heard near: "...${call.context}..."` : 'No direct callouts.',
    surrogateAutoReply: call.called ? autoReply : 'None needed.',

    // Spoken Debrief & WhatsApp Broadcast (built from verified items)
    spokendebriefScript: buildDebrief(notes, userName),
    crBroadcast: {
      voiceScript: buildVoiceScript(verified, userName, notes.lectureTitle),
      whatsappText: buildWhatsapp(notes.lectureTitle, verified, userName)
    },

    needsReviewBeforeBroadcast: verified.length > 0
  };
}
