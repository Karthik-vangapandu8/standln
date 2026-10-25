import fs from 'fs';
import path from 'path';

const CATALOG_PATH = path.resolve('data/drive_catalog.json');

// Stop words that shouldn't trigger subject or title matches on their own
const STOP_WORDS = new Set([
  'send', 'me', 'please', 'give', 'notes', 'pdf', 'document', 'file', 
  'materials', 'material', 'link', 'drive', 'bro', 'sir', 'cr', 'the', 
  'for', 'and', 'with', 'you', 'can', 'have', 'from', 'this', 'that', 
  'about', 'some', 'class', 'here', 'show', 'need', 'want', 'all', 'any'
]);

function loadCatalog() {
  try {
    if (!fs.existsSync(CATALOG_PATH)) return null;
    const raw = fs.readFileSync(CATALOG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[Drive Search Catalog Error]:', err.message);
    return null;
  }
}

/**
 * Damerau-Levenshtein distance for typo tolerance (handles transpositions like "verliog" -> "verilog")
 */
function damerauLevenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const d = [];
  for (let i = 0; i <= a.length; i++) {
    d[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    d[0][j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,       // deletion
        d[i][j - 1] + 1,       // insertion
        d[i - 1][j - 1] + cost // substitution
      );

      // Transposition
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * Check if word matches target with typo tolerance
 */
function isFuzzyMatch(word, target) {
  if (word === target) return { match: true, exact: true };
  if (target.includes(word) || word.includes(target)) return { match: true, exact: true };

  const minLen = Math.min(word.length, target.length);
  if (minLen < 4) return { match: false, exact: false };

  const maxDist = minLen >= 6 ? 2 : 1;
  const dist = damerauLevenshtein(word, target);
  if (dist <= maxDist) {
    return { match: true, exact: false, dist };
  }
  return { match: false, exact: false };
}

/**
 * Search the 6th Sem EEE Google Drive catalog
 * Matches subject, unit, specific notes, labs, and syllabus documents with typo tolerance
 */
export function searchDriveCatalog(query = '') {
  const catalog = loadCatalog();
  if (!catalog || !catalog.subjects) return null;

  const cleanQuery = query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
  const allQueryWords = cleanQuery.split(/\s+/).filter(Boolean);
  const meaningfulWords = allQueryWords.filter(w => !STOP_WORDS.has(w) && w.length >= 2);

  // Extract unit number if mentioned (e.g. "unit 5", "unit-2", "u1", "unit 3")
  let requestedUnit = null;
  const unitMatch = cleanQuery.match(/unit\s*([1-5])|u([1-5])/);
  if (unitMatch) {
    requestedUnit = parseInt(unitMatch[1] || unitMatch[2], 10);
  }

  let bestMatch = null;
  let highestScore = 0;

  // 1. Search specific files / items first (most specific)
  for (const subject of catalog.subjects) {
    if (Array.isArray(subject.items)) {
      for (const item of subject.items) {
        let score = 0;

        // Keyword matching
        for (const kw of item.keywords || []) {
          const kwLower = kw.toLowerCase();
          if (cleanQuery.includes(kwLower)) {
            score += 25;
          } else {
            // Check word-by-word fuzzy match on multi-word keywords or single keywords
            for (const qw of meaningfulWords) {
              const fz = isFuzzyMatch(qw, kwLower);
              if (fz.match) {
                score += fz.exact ? 15 : 12;
              }
            }
          }
        }

        // Title word matching (ignoring stop words)
        const itemTitleWords = item.title.toLowerCase().split(/\s+/).filter(w => !STOP_WORDS.has(w));
        for (const word of meaningfulWords) {
          for (const tw of itemTitleWords) {
            const fz = isFuzzyMatch(word, tw);
            if (fz.match) {
              score += fz.exact ? 8 : 6;
            }
          }
        }

        // Unit alignment
        if (requestedUnit && item.unit === requestedUnit) {
          score += 15;
        }

        if (score > highestScore) {
          highestScore = score;
          bestMatch = {
            type: 'file',
            title: item.title,
            subjectCode: subject.code,
            subjectName: subject.name,
            url: item.url,
            parentFolderUrl: subject.folder_url,
            unit: item.unit,
            score
          };
        }
      }
    }

    // 2. Search subject / lab / structure folders
    let subjectScore = 0;
    for (const kw of subject.keywords || []) {
      const kwLower = kw.toLowerCase();
      if (cleanQuery.includes(kwLower)) {
        subjectScore += 20;
      } else {
        for (const qw of meaningfulWords) {
          const fz = isFuzzyMatch(qw, kwLower);
          if (fz.match) {
            subjectScore += fz.exact ? 14 : 10;
          }
        }
      }
    }

    const subjectNameWords = subject.name.toLowerCase().split(/\s+/).filter(w => !STOP_WORDS.has(w));
    for (const word of meaningfulWords) {
      for (const sw of subjectNameWords) {
        const fz = isFuzzyMatch(word, sw);
        if (fz.match) {
          subjectScore += fz.exact ? 6 : 4;
        }
      }
    }

    if (subjectScore > highestScore && (!bestMatch || subjectScore > bestMatch.score + 5)) {
      highestScore = subjectScore;
      bestMatch = {
        type: 'folder',
        title: subject.name,
        subjectCode: subject.code,
        subjectName: subject.name,
        url: subject.folder_url,
        parentFolderUrl: subject.folder_url,
        itemsCount: subject.items ? subject.items.length : 0,
        score: subjectScore
      };
    }
  }

  // Minimum confidence threshold: if score < 8, no reliable match
  if (!bestMatch || highestScore < 8) {
    return null;
  }

  return bestMatch;
}
