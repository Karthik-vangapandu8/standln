import fs from 'fs';
import path from 'path';

const MATERIALS_DIR = path.resolve('materials');

const STOP_WORDS = new Set([
  'send', 'the', 'notes', 'note', 'pdf', 'file', 'files', 'materials', 'material', 
  'bro', 'please', 'for', 'hi', 'hello', 'hey', 'cr', 'me', 'some', 'topic', 
  'give', 'share', 'can', 'you', 'want', 'need', 'of', 'and', 'in', 'on', 'about'
]);

/**
 * Search for matching PDF or document in local laptop materials folder
 */
export function searchLaptopMaterials(query = '') {
  if (!fs.existsSync(MATERIALS_DIR)) {
    fs.mkdirSync(MATERIALS_DIR, { recursive: true });
  }

  const files = fs.readdirSync(MATERIALS_DIR).filter(f => f.endsWith('.pdf') || f.endsWith('.docx') || f.endsWith('.txt'));
  
  if (files.length === 0) {
    return null;
  }

  const cleanQuery = query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
  const rawWords = cleanQuery.split(/\s+/).filter(Boolean);
  const meaningfulWords = rawWords.filter(w => !STOP_WORDS.has(w) && (w.length >= 2));

  let bestMatch = null;
  let highestScore = 0;

  for (const file of files) {
    const cleanFileName = file.toLowerCase().replace(/[^a-z0-9]/g, ' ');
    let score = 0;

    for (const word of meaningfulWords) {
      if (cleanFileName.includes(word)) {
        score += 3;
      }
    }

    // Direct multi-word phrases and common abbreviations
    if (cleanQuery.includes('ac machine') && (cleanFileName.includes('ac') || cleanFileName.includes('machine'))) score += 10;
    if (cleanQuery.includes('dc machine') && (cleanFileName.includes('dc') || cleanFileName.includes('machine'))) score += 10;
    if (cleanQuery.includes('transformer') && cleanFileName.includes('transformer')) score += 10;
    if (cleanQuery.includes('calculus') && cleanFileName.includes('calculus')) score += 10;
    if (cleanQuery.includes('integration') && cleanFileName.includes('integration')) score += 8;

    // Check 2-letter tokens explicitly (e.g. "ac", "dc")
    if (meaningfulWords.includes('ac') && cleanFileName.includes('ac')) score += 8;
    if (meaningfulWords.includes('dc') && cleanFileName.includes('dc')) score += 8;

    if (score > highestScore) {
      highestScore = score;
      bestMatch = file;
    }
  }

  // Fallback to first PDF if general notes requested or no specific match
  if (!bestMatch && files.length > 0) {
    bestMatch = files[0];
  }

  if (bestMatch) {
    const topic = bestMatch.replace(/_/g, ' ').replace(/\.(pdf|docx|txt)$/i, '');
    return {
      fileName: bestMatch,
      filePath: path.join(MATERIALS_DIR, bestMatch),
      fileSize: fs.statSync(path.join(MATERIALS_DIR, bestMatch)).size,
      topic: topic,
      score: highestScore
    };
  }

  return null;
}

