import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CACHE_DIR = path.resolve('cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * Synthesize speech using ElevenLabs Flash v2.5 / Multilingual v2
 * Includes MD5 caching to avoid repeated API costs (Padh Ke Batao pattern).
 */
export async function synthesizeSpeech(text, customVoiceId = null) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = customVoiceId || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    console.warn('[ElevenLabs TTS] synthesizeSpeech called with empty text, skipping.');
    return { audioBuffer: Buffer.from([]), cached: true, fileName: '', url: null };
  }

  if (!apiKey || apiKey === 'your_elevenlabs_api_key_here') {
    throw new Error('ELEVENLABS_API_KEY is not set in .env');
  }

  // Create hash for caching
  const cacheKey = crypto.createHash('md5').update(`${voiceId}:${text}`).digest('hex');
  const cacheFilePath = path.join(CACHE_DIR, `${cacheKey}.mp3`);

  if (fs.existsSync(cacheFilePath)) {
    console.log(`[ElevenLabs Cache Hit] Reusing cached audio: ${cacheKey}.mp3`);
    return {
      audioBuffer: fs.readFileSync(cacheFilePath),
      cached: true,
      fileName: `${cacheKey}.mp3`,
      url: `/audio/${cacheKey}.mp3`
    };
  }

  console.log(`[ElevenLabs TTS] Generating speech with voice ${voiceId} using Flash v2.5...`);
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text: text,
      model_id: 'eleven_flash_v2_5',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.2,
        use_speaker_boost: true
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    // Fallback to eleven_multilingual_v2 if flash model fails
    console.warn(`[ElevenLabs TTS] Flash model failed (${response.status}): ${errorText}. Trying multilingual_v2 fallback...`);
    const fallbackResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      })
    });

    if (!fallbackResponse.ok) {
      const fallbackErr = await fallbackResponse.text();
      throw new Error(`ElevenLabs TTS error (${fallbackResponse.status}): ${fallbackErr}`);
    }

    const arrayBuffer = await fallbackResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(cacheFilePath, buffer);
    return {
      audioBuffer: buffer,
      cached: false,
      fileName: `${cacheKey}.mp3`,
      url: `/audio/${cacheKey}.mp3`
    };
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync(cacheFilePath, buffer);

  return {
    audioBuffer: buffer,
    cached: false,
    fileName: `${cacheKey}.mp3`,
    url: `/audio/${cacheKey}.mp3`
  };
}

/**
 * Transcribe audio using ElevenLabs Scribe API or Whisper endpoint
 */
export async function transcribeAudio(audioBuffer, mimeType = 'audio/mpeg') {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey || apiKey === 'your_elevenlabs_api_key_here') {
    throw new Error('ELEVENLABS_API_KEY is not set in .env');
  }

  const ext = (mimeType.includes('ogg') || mimeType.includes('oga') || mimeType.includes('opus'))
    ? 'audio.ogg'
    : (mimeType.includes('wav') ? 'audio.wav' : 'audio.mp3');

  console.log(`[ElevenLabs STT] Transcribing audio with ElevenLabs Scribe (${mimeType}, file: ${ext})...`);
  const formData = new FormData();
  const blob = new Blob([audioBuffer], { type: mimeType });
  formData.append('file', blob, ext);
  formData.append('model_id', 'scribe_v1');

  const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey
    },
    body: formData
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.warn(`[ElevenLabs Scribe] Error (${response.status}): ${errorText}`);
    throw new Error(`ElevenLabs Scribe error: ${errorText}`);
  }

  const data = await response.json();
  return (data.text || '').trim();
}

/**
 * Fetch available voices from ElevenLabs account (including custom cloned voices)
 */
export async function getVoices() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const configuredVoiceId = process.env.ELEVENLABS_VOICE_ID || 'PIzF7N4AZiqRy5BOSpFC';
  
  const defaultVoices = [
    { voice_id: configuredVoiceId, name: '🎙️ Karthik (My Cloned Voice - CR)', category: 'cloned' },
    { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel (Calm & Clear)', category: 'premade' },
    { voice_id: 'ErXwobaYiN019PkySvjV', name: 'Antoni (Confident Male)', category: 'premade' },
    { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella (Expressive)', category: 'premade' },
    { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George (Warm British)', category: 'premade' }
  ];

  if (!apiKey || apiKey === 'your_elevenlabs_api_key_here') {
    return defaultVoices;
  }

  try {
    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: {
        'xi-api-key': apiKey
      }
    });

    if (!response.ok) {
      return defaultVoices;
    }

    const data = await response.json();
    const fetched = (data.voices || []).map(v => ({
      voice_id: v.voice_id,
      name: v.voice_id === configuredVoiceId ? `🎙️ ${v.name} (My Cloned Voice - CR)` : v.name,
      category: v.category,
      labels: v.labels,
      preview_url: v.preview_url
    }));

    // If configured cloned voice isn't in fetched list, put it first
    if (!fetched.find(v => v.voice_id === configuredVoiceId)) {
      fetched.unshift({
        voice_id: configuredVoiceId,
        name: '🎙️ Karthik (My Cloned Voice - CR)',
        category: 'cloned'
      });
    }

    return fetched.length > 0 ? fetched : defaultVoices;
  } catch (err) {
    console.error('Failed to fetch voices:', err);
    return defaultVoices;
  }
}

