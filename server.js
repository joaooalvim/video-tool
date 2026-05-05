require('dotenv').config();
const express = require('express');
const ffmpegPath = require('ffmpeg-static');
const Anthropic = require('@anthropic-ai/sdk');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const VIDEOS_DIR = path.join(__dirname, 'public', 'videos');
const FONTS_DIR = path.join(__dirname, 'fonts');
fs.mkdirSync(VIDEOS_DIR, { recursive: true });
fs.mkdirSync(FONTS_DIR, { recursive: true });

// Auto-install project fonts — macOS uses ~/Library/Fonts, Linux uses ~/.local/share/fonts
const systemFontsDir = process.platform === 'darwin'
  ? path.join(require('os').homedir(), 'Library', 'Fonts')
  : path.join(require('os').homedir(), '.local', 'share', 'fonts');
fs.mkdirSync(systemFontsDir, { recursive: true });
fs.readdirSync(FONTS_DIR)
  .filter(f => /\.(ttf|otf)$/i.test(f))
  .forEach(file => {
    const dest = path.join(systemFontsDir, file);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(FONTS_DIR, file), dest);
      console.log(`Installed font: ${file} → ${systemFontsDir}`);
    }
  });

const lookIds = (process.env.HEYGEN_AVATAR_LOOK_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
let lookIndex = 0;

function nextLookId() {
  if (lookIds.length === 0) return null;
  const id = lookIds[lookIndex % lookIds.length];
  lookIndex++;
  return id;
}

// Stores word timestamps keyed by videoId — used later for caption burning
const videoTimestamps = new Map();

// ---------------------------------------------------------------------------
// POST /api/generate
// 1. ElevenLabs with-timestamps → audio buffer + word timing
// 2. Upload audio to HeyGen → public URL
// 3. Kick off HeyGen video generation → video_id
// ---------------------------------------------------------------------------
app.post('/api/generate', async (req, res) => {
  const { script, avatarIV } = req.body;

  if (!script || typeof script !== 'string') {
    return res.status(400).json({ error: 'Script is required.' });
  }
  if (script.length > 3000) {
    return res.status(400).json({ error: 'Script exceeds 3000 character limit.' });
  }

  try {
    // --- Step 1: Enhance script with ElevenLabs v3 tone tags via Claude ---
    console.log('[1/4] Enhancing script with tone tags...');
    const enhancedScript = await enhanceScript(script);
    console.log('   Enhanced script:', enhancedScript);

    // --- Step 2: ElevenLabs TTS with timestamps ---
    console.log('[2/4] Generating audio with ElevenLabs...');
    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}/with-timestamps`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: enhancedScript,
          model_id: 'eleven_v3',
          voice_settings: { stability: 0 },
        }),
      }
    );

    if (!ttsRes.ok) {
      const body = await ttsRes.text();
      throw new Error(`ElevenLabs error (${ttsRes.status}): ${body}`);
    }

    const ttsData = await ttsRes.json();
    const audioBuffer = Buffer.from(ttsData.audio_base64, 'base64');
    const words = extractWordTimestamps(ttsData.alignment);
    console.log(`   Audio generated — ${audioBuffer.length} bytes, ${words.length} words`);

    // --- Step 2: Upload audio to HeyGen ---
    console.log('[3/4] Uploading audio to HeyGen...');
    const uploadRes = await fetch('https://upload.heygen.com/v1/asset', {
      method: 'POST',
      headers: {
        'X-Api-Key': process.env.HEYGEN_API_KEY,
        'Content-Type': 'audio/mpeg',
      },
      body: audioBuffer,
    });

    if (!uploadRes.ok) {
      const body = await uploadRes.text();
      throw new Error(`HeyGen upload error (${uploadRes.status}): ${body}`);
    }

    const uploadData = await uploadRes.json();
    const audioUrl = uploadData.data?.url;
    if (!audioUrl) throw new Error('HeyGen upload returned no URL.');
    console.log(`   Audio URL: ${audioUrl}`);

    // --- Step 3: Generate video ---
    const lookId = nextLookId();
    console.log(`[4/4] Starting HeyGen video generation... (look: ${lookId ?? 'default'}, avatarIV: ${!!avatarIV})`);
    const character = lookId
      ? { type: 'talking_photo', talking_photo_id: lookId, ...(avatarIV && { use_avatar_iv_model: true }) }
      : { type: 'avatar', avatar_id: process.env.HEYGEN_AVATAR_ID, avatar_style: 'normal' };
    const videoRes = await fetch('https://api.heygen.com/v2/video/generate', {
      method: 'POST',
      headers: {
        'X-Api-Key': process.env.HEYGEN_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        video_inputs: [{ character, voice: { type: 'audio', audio_url: audioUrl } }],
        dimension: { width: 720, height: 1280 },
        test: false,
      }),
    });

    if (!videoRes.ok) {
      const body = await videoRes.text();
      throw new Error(`HeyGen generate error (${videoRes.status}): ${body}`);
    }

    const videoData = await videoRes.json();
    const videoId = videoData.data?.video_id;
    if (!videoId) throw new Error('HeyGen returned no video_id.');
    console.log(`   Video ID: ${videoId}`);

    // Stash timestamps in memory and on disk for the finalize step (survives restarts)
    videoTimestamps.set(videoId, words);
    fs.writeFileSync(
      path.join(VIDEOS_DIR, `${videoId}.json`),
      JSON.stringify({ words, videoUrl: null })
    );

    res.json({ videoId });
  } catch (err) {
    console.error('[ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/status/:videoId — proxy to HeyGen status
// ---------------------------------------------------------------------------
app.get('/api/status/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const statusRes = await fetch(
      `https://api.heygen.com/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`,
      { headers: { 'X-Api-Key': process.env.HEYGEN_API_KEY } }
    );
    if (!statusRes.ok) {
      const body = await statusRes.text();
      throw new Error(`HeyGen status error (${statusRes.status}): ${body}`);
    }
    const data = await statusRes.json();
    if (data.data?.status === 'failed') {
      console.error('[HEYGEN FAILURE]', JSON.stringify(data.data, null, 2));
    }
    res.json(data.data ?? data);
  } catch (err) {
    console.error('[ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/meta/:videoId — returns stored HeyGen video URL for regen after restart
// ---------------------------------------------------------------------------
app.get('/api/meta/:videoId', (req, res) => {
  const metaPath = path.join(VIDEOS_DIR, `${req.params.videoId}.json`);
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'Not found.' });
  res.json(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
});

// ---------------------------------------------------------------------------
// POST /api/finalize/:videoId
// Downloads HeyGen video, burns ASS captions via FFmpeg, returns local URL
// ---------------------------------------------------------------------------
app.post('/api/finalize/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { videoUrl } = req.body;

  if (!videoUrl) return res.status(400).json({ error: 'videoUrl is required.' });

  let words = videoTimestamps.get(videoId);
  if (!words) {
    // Try loading from disk (server may have restarted)
    const metaPath = path.join(VIDEOS_DIR, `${videoId}.json`);
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      words = meta.words;
      videoTimestamps.set(videoId, words);
    }
  }
  if (!words) return res.status(404).json({ error: 'No timestamps found for this video.' });

  // Persist the HeyGen video URL so regen works after restarts
  const metaPath = path.join(VIDEOS_DIR, `${videoId}.json`);
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!meta.videoUrl) {
      meta.videoUrl = videoUrl;
      fs.writeFileSync(metaPath, JSON.stringify(meta));
    }
  }

  const inputPath = `/tmp/hg_${videoId}_in.mp4`;
  const assPath = `/tmp/hg_${videoId}.ass`;
  const outputPath = path.join(VIDEOS_DIR, `${videoId}.mp4`);

  try {
    // Download HeyGen video
    console.log('[4/4] Downloading video from HeyGen...');
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) throw new Error(`Failed to download video: ${videoRes.status}`);
    fs.writeFileSync(inputPath, Buffer.from(await videoRes.arrayBuffer()));

    // Detect dimensions and auto-crop white bars
    const dims = await getVideoDimensions(inputPath);
    const crop = await detectCrop(inputPath);
    const assDims = crop ? { width: parseInt(crop.split(':')[0]), height: parseInt(crop.split(':')[1]) } : dims;
    console.log(`      Video: ${dims.width}x${dims.height}, crop: ${crop ?? 'none'}`);

    // Write ASS subtitle file
    console.log('      Generating subtitle file...');
    fs.writeFileSync(assPath, generateASS(words, assDims.width, assDims.height));

    // Burn captions + crop white bars with FFmpeg
    console.log('      Burning captions with FFmpeg...');
    const vf = crop
      ? `crop=${crop},ass=${assPath}:fontsdir=${FONTS_DIR}`
      : `ass=${assPath}:fontsdir=${FONTS_DIR}`;

    await execFileAsync(ffmpegPath, [
      '-i', inputPath,
      '-vf', vf,
      '-c:a', 'copy',
      '-y',
      outputPath,
    ]);

    // Clean up temp files (keep timestamps in memory for caption regen)
    fs.unlinkSync(inputPath);
    fs.unlinkSync(assPath);

    console.log(`      Done → /videos/${videoId}.mp4`);
    res.json({ url: `/videos/${videoId}.mp4` });
  } catch (err) {
    console.error('[ERROR]', err.message);
    for (const f of [inputPath, assPath]) {
      try { fs.unlinkSync(f); } catch {}
    }
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function enhanceScript(script) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const message = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: `You are an expert at adding ElevenLabs v3 audio tags to scripts to make text-to-speech sound more natural and expressive.

ElevenLabs v3 supports inline audio tags that control delivery. Tags go inside angle brackets and are placed inline with the text. Examples of supported tags:
[laughs], [sighs], [whispers], [excited], [sad], [angry], [surprised], [nervous], [serious], [cheerful], [sarcastic], [disappointed], [confused]

Rules:
- Add tags sparingly and only where they genuinely improve delivery — do NOT over-tag
- Place tags immediately before the word or phrase they should affect
- Never add a tag at the very end of the script
- Do not change any of the actual words in the script
- Return ONLY the enhanced script, no explanation

Script:
${script}`,
      },
    ],
  });

  return message.content[0].text.trim();
}


async function detectCrop(videoPath) {
  let stderr = '';
  try {
    const r = await execFileAsync(ffmpegPath, [
      '-i', videoPath,
      '-vf', 'cropdetect=limit=20:round=2:skip=2',
      '-frames:v', '60',
      '-f', 'null', '-',
    ]);
    stderr = r.stderr || '';
  } catch (e) {
    stderr = e.stderr || '';
  }
  const matches = [...stderr.matchAll(/crop=(\d+:\d+:\d+:\d+)/g)];
  if (!matches.length) return null;
  return matches[matches.length - 1][1]; // "w:h:x:y"
}

async function getVideoDimensions(videoPath) {
  let stderr = '';
  try {
    const r = await execFileAsync(ffmpegPath, ['-i', videoPath]);
    stderr = r.stderr || '';
  } catch (e) {
    stderr = e.stderr || '';
  }
  const match = stderr.match(/(\d{3,4})x(\d{3,4})/);
  if (match) return { width: parseInt(match[1]), height: parseInt(match[2]) };
  return { width: 1280, height: 720 }; // fallback
}

async function detectAudioOffset(videoPath) {
  let stderr = '';
  try {
    const result = await execFileAsync(ffmpegPath, [
      '-i', videoPath,
      '-af', 'silencedetect=noise=-35dB:d=0.05',
      '-f', 'null', '-',
    ]);
    stderr = result.stderr || '';
  } catch (e) {
    stderr = e.stderr || '';
  }

  // Parse silence_start / silence_end pairs from FFmpeg output
  const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map(m => parseFloat(m[1]));
  const ends   = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map(m => parseFloat(m[1]));

  // Only use it if silence starts at the very beginning of the video
  if (starts.length > 0 && starts[0] < 0.1 && ends.length > 0) {
    return ends[0];
  }
  return 0;
}

function extractWordTimestamps(alignment) {
  const { characters, character_start_times_seconds, character_end_times_seconds } = alignment;
  const words = [];
  let current = '';
  let wordStart = null;

  for (let i = 0; i < characters.length; i++) {
    const char = characters[i];
    if (char === ' ' || char === '\n' || char === '\r') {
      if (current) {
        words.push({ word: current, start: wordStart, end: character_end_times_seconds[i - 1] });
        current = '';
        wordStart = null;
      }
    } else {
      if (!current) wordStart = character_start_times_seconds[i];
      current += char;
    }
  }
  if (current) {
    words.push({ word: current, start: wordStart, end: character_end_times_seconds[characters.length - 1] });
  }
  return words;
}

function toASSTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.round((s % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

const WORDS_PER_LINE = 2;
const MAX_LINES = 2;
const CHUNK_SIZE = 3; // 3 words per chunk max across 2 lines

function buildChunks(words) {
  const chunks = [];
  let current = [];

  for (const word of words) {
    current.push(word);
    const isSentenceEnd = /[.!?]$/.test(word.word);
    // Break at sentence end OR when the current line is full and we're at a line boundary
    if (isSentenceEnd || current.length >= CHUNK_SIZE) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function generateASS(words, width = 720, height = 1280) {
  const fontName = process.env.CAPTION_FONT || 'Arial';
  const posX = Math.round(width / 2);
  const posY = Math.round(height * 0.6);
  const fontSize = Math.round(height * 0.05); // 5% of height — scales for any resolution

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${fontName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,6,0,5,10,10,10,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const chunks = buildChunks(words);
  const dialogues = [];

  for (const chunk of chunks) {
    // Split chunk into up to 2 lines
    const line1 = chunk.slice(0, WORDS_PER_LINE);
    const line2 = chunk.slice(WORDS_PER_LINE);

    for (let j = 0; j < chunk.length; j++) {
      let start = chunk[j].start;
      let end = j < chunk.length - 1 ? chunk[j + 1].start : chunk[chunk.length - 1].end;

      const renderWord = (w, k) => {
        const display = w.word.replace(/[.!?,;:\u2014]+$/, '').replace(/\u2014/g, '').toUpperCase();
        if (k === j) return `{\\c&H0000F5F4&}${display}{\\c&H00FFFFFF&}`;
        return display;
      };


      const line1Text = line1.map((w, k) => renderWord(w, k)).join(' ');
      const line2Text = line2.length > 0
        ? '\\N' + line2.map((w, k) => renderWord(w, k + WORDS_PER_LINE)).join(' ')
        : '';

      const text = `{\\an5\\pos(${posX},${posY})}${line1Text}${line2Text}`;
      dialogues.push(`Dialogue: 0,${toASSTime(start)},${toASSTime(end)},Default,,0,0,0,,${text}`);
    }
  }

  return header + '\n' + dialogues.join('\n');
}

// ---------------------------------------------------------------------------
// Postiz integration
// ---------------------------------------------------------------------------
const POSTIZ_BASE = 'https://api.postiz.com/public/v1';

app.get('/api/postiz/integrations', async (req, res) => {
  try {
    const r = await fetch(`${POSTIZ_BASE}/integrations`, {
      headers: { Authorization: process.env.POSTIZ_API_KEY },
    });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/postiz/upload', express.raw({ type: '*/*', limit: '500mb' }), async (req, res) => {
  try {
    const filename = req.headers['x-filename'] || 'video.mp4';
    const mimeType = 'video/mp4';
    const form = new FormData();
    form.append('file', new Blob([req.body], { type: mimeType }), filename);
    const r = await fetch(`${POSTIZ_BASE}/upload`, {
      method: 'POST',
      headers: { Authorization: process.env.POSTIZ_API_KEY },
      body: form,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.message || `Postiz upload error (${r.status})`);
    res.json(data);
  } catch (err) {
    console.error('[POSTIZ UPLOAD]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/postiz/draft', async (req, res) => {
  const { integrationId, integrationType, posts } = req.body;
  // posts: [{ uploadId, uploadPath, caption }]
  try {
    const results = [];
    for (const post of posts) {
      const r = await fetch(`${POSTIZ_BASE}/posts`, {
        method: 'POST',
        headers: { Authorization: process.env.POSTIZ_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'draft',
          date: new Date().toISOString(),
          shortLink: false,
          tags: [],
          posts: [{
            integration: { id: integrationId },
            value: [{
              content: post.caption || '',
              image: [{ id: post.uploadId, path: post.uploadPath }],
            }],
            settings: {
              __type: integrationType || 'instagram',
              post_type: 'post',
              is_trial_reel: false,
              collaborators: [],
            },
          }],
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.message || `Postiz post error (${r.status})`);
      results.push(data);
    }
    res.json({ results });
  } catch (err) {
    console.error('[POSTIZ DRAFT]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\nVideo tool running at http://localhost:${PORT}\n`);
});
