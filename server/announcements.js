import fs from 'fs';
import path from 'path';

const ANNOUNCEMENTS_FILE = path.join(process.cwd(), 'data', 'announcements.json');

/**
 * Load all stored announcements
 */
export function getAnnouncements() {
  try {
    if (!fs.existsSync(ANNOUNCEMENTS_FILE)) {
      fs.writeFileSync(ANNOUNCEMENTS_FILE, JSON.stringify([], null, 2));
      return [];
    }
    const raw = fs.readFileSync(ANNOUNCEMENTS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[Announcements Load Error]:', err.message);
    return [];
  }
}

/**
 * Save a new announcement to data/announcements.json
 */
export function saveAnnouncement(announcement) {
  try {
    const list = getAnnouncements();
    const newEntry = {
      id: announcement.id || `ann_${Date.now()}`,
      createdAt: announcement.createdAt || new Date().toISOString(),
      title: announcement.title || 'Class Announcement',
      rawText: announcement.text || announcement.rawText,
      voiceUrl: announcement.voiceUrl || null,
      status: announcement.status || 'Active', // 'Active', 'Staged', 'Archived'
      details: announcement.details || {},
      author: announcement.author || 'CR Karthik'
    };
    list.unshift(newEntry);
    fs.writeFileSync(ANNOUNCEMENTS_FILE, JSON.stringify(list, null, 2));
    return newEntry;
  } catch (err) {
    console.error('[Announcements Save Error]:', err.message);
    return null;
  }
}

/**
 * Delete an announcement by ID
 */
export function deleteAnnouncement(id) {
  try {
    const list = getAnnouncements();
    const updated = list.filter(item => item.id !== id);
    fs.writeFileSync(ANNOUNCEMENTS_FILE, JSON.stringify(updated, null, 2));
    return true;
  } catch (err) {
    console.error('[Announcements Delete Error]:', err.message);
    return false;
  }
}

/**
 * Toggle or update an announcement status
 */
export function updateAnnouncementStatus(id, newStatus) {
  try {
    const list = getAnnouncements();
    const item = list.find(a => a.id === id);
    if (!item) return null;
    item.status = newStatus;
    fs.writeFileSync(ANNOUNCEMENTS_FILE, JSON.stringify(list, null, 2));
    return item;
  } catch (err) {
    console.error('[Announcements Update Error]:', err.message);
    return null;
  }
}

/**
 * Detect if an incoming classmate query is asking for class deadlines, schedules, or announcements
 */
export function isDeadlineOrScheduleQuery(query) {
  const q = query.toLowerCase();
  const scheduleTriggers = [
    'when is', 'when are', 'deadline', 'due date', 'due', 'submission', 'submit',
    'shifted', 'class timing', 'room', 'schedule', 'announcement',
    'notice', 'exam date', 'tomorrow lecture', 'lab report due',
    'what time', 'postponed', 'is class cancelled', 'any update',
    'mid exam', 'second mid', '2nd mid', 'mids', 'mid',
    'sem end', 'semester end', 'end exam', 'end exams', 'practical exam',
    'practical exams', 'practicals', 'lab exam', 'lab exams', 'viva',
    'timetable', 'time table', 'calendar', 'dates', 'exam dates', 'next sem'
  ];
  return scheduleTriggers.some(trigger => q.includes(trigger));
}

/**
 * Returns true if an announcement is a class-specific notice (exam, room shift, deadline)
 * Returns false for general opportunity/competition forwards that shouldn't answer schedule questions
 */
function isScheduleRelevantNotice(ann) {
  const titleLower = (ann.title || '').toLowerCase();
  const textLower  = (ann.rawText || '').toLowerCase();
  const combined   = `${titleLower} ${textLower}`;

  // Notices that are purely informational forwards — not class schedule answers
  const opportunityKeywords = [
    'linkedin', 'unstop', 'competition', 'prize pool', 'win prizes',
    'hackathon', 'internship opportunity', 'register', 'get unstoppable',
    'sponsorship', 'fellowship', 'scholarship', 'webinar', 'workshop'
  ];
  if (opportunityKeywords.some(k => combined.includes(k))) return false;

  // Must contain at least one schedule-related word to be eligible
  const scheduleWords = [
    'exam', 'viva', 'mid', 'practical', 'lab', 'deadline', 'submission',
    'room', 'hall', 'shifted', 'postponed', 'cancelled', 'lecture',
    'schedule', 'timetable', 'record', 'observation', 'report'
  ];
  return scheduleWords.some(k => combined.includes(k));
}

/**
 * Strict lookup for deadline / schedule questions.
 * Never hallucinates dates or room numbers.
 * Returns { found: true, answer, voiceScript } or { found: false, fallbackAnswer, fallbackScript }
 */
export function answerScheduleQuery(query) {
  const allAnnouncements = getAnnouncements();
  // Only search notices that are both Active AND schedule-relevant (not opportunity forwards)
  const announcements = allAnnouncements.filter(
    a => (a.status === 'Active' || !a.status) && isScheduleRelevantNotice(a)
  );
  const q = query.toLowerCase();

  // If no relevant schedule notices exist
  if (!announcements || announcements.length === 0) {
    return {
      found: false,
      answer: "I don't have an official announcement on that yet. Check with Professor or wait for CR update.",
      voiceScript: "Hey, this is an AI clone of Karthik's voice. I don't have an official announcement on that yet. Please check with the professor or wait for a CR update."
    };
  }

  // Keywords to extract (keeping 3-letter words like 'mid', 'sem', 'lab', 'via')
  const stopWords = new Set(['when', 'what', 'which', 'where', 'there', 'class', 'have', 'from', 'with', 'date', 'dates', 'tell', 'about', 'send', 'will']);
  const words = q.split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !stopWords.has(w));

  let bestMatch = null;
  let bestScore = 0;

  for (const ann of announcements) {
    const title = (ann.title || '').toLowerCase();
    const content = `${title} ${(ann.rawText || '')}`.toLowerCase();
    let score = 0;

    // Direct keyword overlaps — title matches are worth more than body matches
    for (const w of words) {
      if (title.includes(w)) score += 5;
      else if (content.includes(w)) score += 2;
    }

    // Specific intent bonuses for common exam queries
    if ((q.includes('mid') || q.includes('2nd mid')) && (content.includes('mid') || content.includes('second mid'))) {
      score += title.includes('mid') ? 25 : 10;
    }
    if ((q.includes('practical') || q.includes('lab exam') || q.includes('practicals')) && content.includes('practical')) {
      score += title.includes('practical') ? 25 : 10;
    }
    if ((q.includes('sem end') || q.includes('semester end') || q.includes('end exam')) && (content.includes('sem end') || content.includes('semester end'))) {
      score += (title.includes('sem end') || title.includes('semester end')) ? 25 : 10;
    }
    if ((q.includes('timetable') || q.includes('time table') || q.includes('calendar') || q.includes('all exams') || q.includes('all dates')) && (title.includes('calendar') || title.includes('timetable') || title.includes('dates'))) {
      score += 25;
    }
    // Viva-specific boost
    if (q.includes('viva') && content.includes('viva')) {
      score += 20;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = ann;
    }
  }

  // Require a meaningful match score — single weak word overlaps should NOT qualify
  const MIN_SCORE = 6;

  if (bestMatch && bestScore >= MIN_SCORE) {
    // Strip markdown, emoji and bullet symbols from voice script so ElevenLabs doesn't read them aloud
    const cleanForVoice = (bestMatch.rawText || '')
      .replace(/[*_`~#>]/g, '')
      .replace(/^[•\-\*]\s*/gm, '')
      .replace(/\[[^\]]+\]\([^)]+\)/g, '')
      .replace(/[\u{1F000}-\u{1FFFF}]|[\u{2700}-\u{27BF}]|[\u{FE00}-\u{FEFF}]|\u{1F300}-\u{1F5FF}|📢|🎙️|📌|🔗|⏰|👉|🔥|🧩|✍️|→/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 250); // Keep it short for voice

    return {
      found: true,
      announcement: bestMatch,
      answer: `📢 *Official Announcement from CR (${new Date(bestMatch.createdAt).toLocaleDateString()}):*\n\n` +
              `*${bestMatch.title}*\n${bestMatch.rawText}\n\n` +
              `_(Verified against CR official class calendar)_`,
      voiceScript: `Hey, this is an AI clone of Karthik's voice. Regarding your question: ${cleanForVoice}`
    };
  }

  // Not found — honest "I don't know" rather than guessing
  return {
    found: false,
    answer: "I don't have an official announcement on that yet. Check with Professor or wait for CR update.",
    voiceScript: "Hey, this is an AI clone of Karthik's voice. I don't have an official announcement on that yet. Please check with the professor or wait for a CR update."
  };
}
