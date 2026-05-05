// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
  });
});

const scriptEl = document.getElementById('script');
const countEl = document.getElementById('count');
const charCountEl = document.querySelector('.char-count');
const generateBtn = document.getElementById('generateBtn');
const avatarIVToggle = document.getElementById('avatarIV');
const jobsEl = document.getElementById('jobs');

const POLL_INTERVAL_MS = 10_000;
let jobCounter = 0;

// Character counter
scriptEl.addEventListener('input', () => {
  const len = scriptEl.value.length;
  countEl.textContent = len;
  charCountEl.className = 'char-count';
  if (len > 2800) charCountEl.classList.add('warn');
  if (len > 3000) charCountEl.classList.add('over');
});

generateBtn.addEventListener('click', () => {
  const script = scriptEl.value.trim();
  if (!script || script.length > 3000) return;

  const useAvatarIV = avatarIVToggle.checked;

  scriptEl.value = '';
  countEl.textContent = '0';
  charCountEl.className = 'char-count';

  startJob(script, useAvatarIV);
});

function startJob(script, useAvatarIV = false) {
  const id = ++jobCounter;
  const preview = script.length > 80 ? script.slice(0, 80) + '…' : script;

  const card = document.createElement('div');
  card.className = 'job-card';
  card.innerHTML = `
    <div class="job-header">
      <span class="job-num">#${id}</span>
      <span class="job-preview">${escapeHtml(preview)}</span>
    </div>
    <div class="job-status generating">
      <span class="dot"></span>
      <span class="job-status-text">Generating audio...</span>
    </div>
    <div class="job-result hidden">
      <video controls></video>
      <div class="job-actions">
        <a class="download-btn" download="video-${id}.mp4">Download</a>
        <button class="regen-btn">Regen Captions</button>
      </div>
    </div>
    <div class="job-error hidden"></div>
  `;
  jobsEl.prepend(card);

  const statusEl = card.querySelector('.job-status');
  const statusText = card.querySelector('.job-status-text');
  const resultEl = card.querySelector('.job-result');
  const videoEl = card.querySelector('video');
  const downloadEl = card.querySelector('.download-btn');
  const regenBtn = card.querySelector('.regen-btn');
  const errorEl = card.querySelector('.job-error');

  // videoId and heygenUrl captured here so regen can reuse them
  let currentVideoId = null;
  let heygenVideoUrl = null;

  function setStatus(text, state = 'generating') {
    statusEl.className = `job-status ${state}`;
    statusText.textContent = text;
    statusEl.classList.remove('hidden');
  }

  function showError(msg) {
    statusEl.classList.add('hidden');
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  }

  function showVideo(localUrl) {
    setStatus('Ready', 'done');
    videoEl.src = localUrl + '?t=' + Date.now(); // cache-bust on regen
    downloadEl.href = localUrl;
    resultEl.classList.remove('hidden');
  }

  async function runFinalize() {
    errorEl.classList.add('hidden');
    resultEl.classList.add('hidden');
    setStatus('Adding captions...');

    try {
      // If we lost the HeyGen URL (e.g. page refresh), fetch it from disk
      if (!heygenVideoUrl) {
        const metaRes = await fetch(`/api/meta/${encodeURIComponent(currentVideoId)}`);
        const meta = await metaRes.json();
        if (!metaRes.ok || !meta.videoUrl) throw new Error('Could not recover video URL. Please regenerate the full video.');
        heygenVideoUrl = meta.videoUrl;
      }

      const finalRes = await fetch(`/api/finalize/${encodeURIComponent(currentVideoId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl: heygenVideoUrl }),
      });
      const finalData = await finalRes.json();
      if (!finalRes.ok) throw new Error(finalData.error || 'Caption processing failed.');
      showVideo(finalData.url);
    } catch (err) {
      showError(err.message);
    }
  }

  regenBtn.addEventListener('click', runFinalize);

  // Kick off generation
  fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script, avatarIV: useAvatarIV }),
  })
    .then(res => res.json().then(data => ({ ok: res.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Failed to start generation.');
      currentVideoId = data.videoId;
      setStatus('Rendering video...');
      pollStatus(data.videoId, setStatus, showError, (url) => {
        heygenVideoUrl = url;
        runFinalize();
      });
    })
    .catch(err => showError(err.message));
}

function pollStatus(videoId, setStatus, onError, onComplete) {
  const interval = setInterval(async () => {
    try {
      const res = await fetch(`/api/status/${encodeURIComponent(videoId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to check status.');

      const { status, video_url } = data;

      if (status === 'completed' && video_url) {
        clearInterval(interval);
        onComplete(video_url);
      } else if (status === 'failed') {
        clearInterval(interval);
        const detail = data.error ?? data.message ?? '';
        onError(`HeyGen: video generation failed${detail ? ` — ${detail}` : '.'}`);
      }
    } catch (err) {
      clearInterval(interval);
      onError(err.message);
    }
  }, POLL_INTERVAL_MS);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
