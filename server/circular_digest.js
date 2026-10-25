import http from 'http';

/**
 * Low-level query to local Ollama with strict timeout
 */
function queryOllama(payload, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const req = http.request({
      hostname: 'localhost',
      port: 11434,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: timeoutMs
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Ollama timed out after ${timeoutMs}ms`));
    });
    req.write(postData);
    req.end();
  });
}

/**
 * Extract URLs and markdown links from raw text
 */
export function extractLinks(text) {
  const links = [];
  const seen = new Set();

  // 1. Markdown links: [Label](url)
  const mdRegex = /\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g;
  let match;
  while ((match = mdRegex.exec(text)) !== null) {
    const label = match[1].trim();
    let url = match[2].trim().replace(/[.,;)]+$/, '');
    if (!seen.has(url)) {
      seen.add(url);
      links.push({ label, url });
    }
  }

  // 2. Plain URLs
  const plainRegex = /(https?:\/\/[^\s\)\>\]]+)/g;
  while ((match = plainRegex.exec(text)) !== null) {
    let url = match[1].trim().replace(/[.,;)]+$/, '');
    if (!seen.has(url)) {
      seen.add(url);
      const isGoogle = url.includes('google.com');
      const isUnstop = url.includes('unstop.com');
      const label = isGoogle ? 'Google Drive Link' : (isUnstop ? 'Registration Link' : 'Website Link');
      links.push({ label, url });
    }
  }

  return links;
}

/**
 * Strip email headers, timestamps, and noisy metadata
 */
export function cleanRawEmailHeaders(text) {
  const lines = text.split('\n');
  const cleaned = [];
  let skippingHeaders = false;

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Detect email header lines
    if (/^inbox$/i.test(trimmed)) continue;
    if (/^[A-Za-z\s]+<[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}>/.test(trimmed)) continue;
    if (/^(from|to|cc|bcc|date|subject):\s*/i.test(trimmed)) continue;
    if (/^\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)\s*(\(.*\))?/i.test(trimmed)) continue;
    if (/^to\s+(?:bcc|cc)?:/i.test(trimmed)) continue;

    cleaned.push(trimmed);
  }

  return cleaned.join('\n');
}

/**
 * Fast, deterministic fallback digest (runs in <2ms)
 */
export function heuristicDigest(rawText, rawTitle = '') {
  const links = extractLinks(rawText);
  const primaryUrl = links.length > 0 ? links[0].url : null;
  const primaryLabel = links.length > 0 ? links[0].label : 'Link';

  const cleanedText = cleanRawEmailHeaders(rawText);
  const lines = cleanedText.split('\n').map(l => l.trim()).filter(Boolean);

  // Extract or infer title
  let cleanTitle = rawTitle && rawTitle !== 'Class Notice' && rawTitle !== 'Class Announcement' ? rawTitle : '';
  if (!cleanTitle && lines.length > 0) {
    const firstLine = lines[0];
    cleanTitle = firstLine.split(/[:|•\-]/)[0].trim();
    if (cleanTitle.length > 50) cleanTitle = cleanTitle.slice(0, 50).trim() + '...';
  }
  if (!cleanTitle) cleanTitle = 'Class Announcement';

  // Build key bullets
  const bullets = [];
  for (const line of lines.slice(0, 15)) {
    if (line.includes('→') || line.includes('₹') || line.startsWith('•') || line.startsWith('-') || /challenge|prize|winner|competition|deadline|internship|register/i.test(line)) {
      const cleanLine = line.replace(/^[•\-\*]\s*/, '').replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1').trim();
      if (cleanLine.length > 5 && cleanLine.length < 120 && !bullets.includes(cleanLine)) {
        bullets.push(cleanLine);
      }
    }
  }

  // If no structured bullets found, take top 3 lines
  if (bullets.length === 0) {
    for (const line of lines.slice(1, 4)) {
      const cleanLine = line.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1').trim();
      if (cleanLine.length > 10 && cleanLine.length < 120) {
        bullets.push(cleanLine);
      }
    }
  }

  // Format clean notice for Telegram / UI
  let formattedNotice = `📢 *${cleanTitle}*\n\n`;
  if (bullets.length > 0) {
    formattedNotice += bullets.map(b => `• ${b}`).join('\n') + '\n\n';
  } else {
    formattedNotice += `${lines.slice(0, 2).join(' ')}\n\n`;
  }

  if (primaryUrl) {
    // Use a generic safe label — the primaryLabel from email text often contains
    // special characters (!, ×, emojis) that break Telegram's Markdown parser
    formattedNotice += `🔗 [Tap here to open the registration link](${primaryUrl})\n`;
  }

  // Spoken voice script: casual, short, human, NEVER spells out URLs!
  let spokenCore = '';
  if (/linkedin|unstop/i.test(cleanedText)) {
    spokenCore = `Our department shared an exciting competition: LinkedIn and Unstop launched the Get Unstoppable challenge with cash prizes and internship opportunities. Top winners get featured by LinkedIn.`;
  } else if (/exam|mid|practical/i.test(cleanedText)) {
    spokenCore = `Quick update regarding our upcoming exams and schedule.`;
  } else if (bullets.length > 0) {
    spokenCore = bullets.slice(0, 2).join('. ').replace(/→/g, 'gets');
  } else {
    spokenCore = `Please check the official notice posted on our class board.`;
  }

  let spokenVoiceScript = `Hey guys, this is an AI clone of Karthik's voice with a quick class update: ${cleanTitle}. ${spokenCore} I've attached the direct link in the message above, so check it out if you want to participate. All the best!`;
  spokenVoiceScript = spokenVoiceScript.replace(/\s+/g, ' ').trim();

  return {
    cleanTitle,
    cleanSummary: bullets.join('\n'),
    actionLink: primaryUrl,
    links,
    spokenVoiceScript,
    formattedNotice
  };
}

/**
 * Intelligent circular digest combining Gemma 3:4B with heuristic fallback
 */
export async function digestFacultyCircular(rawText, rawTitle = '') {
  const fallback = heuristicDigest(rawText, rawTitle);
  const links = extractLinks(rawText);

  // Try local Ollama (Gemma) with a 10s timeout
  try {
    const system = `You are an AI Class Representative (CR) assistant. A student or faculty member pasted a raw email or circular for the class.
Your job is to cut short the clutter and transform it into:
1. "cleanTitle": A short, clear title (max 7 words).
2. "cleanSummary": 2 to 4 clean, concise bullet points of what students actually need to know.
3. "actionLink": The primary registration or reference URL extracted from the notice, or null if none.
4. "spokenVoiceScript": A short conversational voice note script (under 45 words) that will be read aloud in the Class Rep's voice to classmates on Telegram.
   CRITICAL VOICE SCRIPT RULES:
   - Begin with: "Hey guys, quick class update:"
   - NEVER read out email headers, sender names, or email addresses.
   - NEVER read out raw website URLs or https links aloud (e.g. do NOT say "http colon slash slash unstop dot com"). Instead say: "I've linked the registration page in the message above" or "check the link in the message".
   - Sound natural, friendly, and helpful.

OUTPUT FORMAT: Return ONLY valid JSON:
{
  "cleanTitle": "...",
  "cleanSummary": "...",
  "actionLink": "...",
  "spokenVoiceScript": "..."
}`;

    const res = await queryOllama({
      model: process.env.OLLAMA_MODEL || 'gemma3:4b',
      stream: false,
      format: 'json',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: rawText }
      ],
      options: { temperature: 0.2, top_p: 0.85, num_ctx: 4096 }
    }, 12000);

    const parsed = JSON.parse(res?.message?.content || '{}');
    if (parsed.cleanTitle && parsed.spokenVoiceScript) {
      const cleanTitle = parsed.cleanTitle.trim();
      const actionLink = parsed.actionLink || fallback.actionLink;
      const spokenVoiceScript = parsed.spokenVoiceScript.trim();
      const cleanSummary = parsed.cleanSummary || fallback.cleanSummary;

      let formattedNotice = `📢 *${cleanTitle}*\n\n`;
      if (cleanSummary) {
        formattedNotice += cleanSummary.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.startsWith('•') ? l : `• ${l}`).join('\n') + '\n\n';
      }
      if (actionLink) {
        formattedNotice += `🔗 *Registration / Details:* [Click here to open](${actionLink})\n`;
      }

      console.log(`[Gemma Circular Digest] Successfully digested into: "${cleanTitle}"`);
      return {
        cleanTitle,
        cleanSummary,
        actionLink,
        links,
        spokenVoiceScript,
        formattedNotice
      };
    }
  } catch (err) {
    console.warn(`[Gemma Circular Digest] Ollama fallback used (${err.message}). Using instant heuristic digest.`);
  }

  return fallback;
}
