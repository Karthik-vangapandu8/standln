// Application state
let currentTab = 'auto-cr';
let activeSampleKey = 'college_class';
let sampleScenarios = {};
let recordedAudioBlob = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordTimerInterval = null;
let recordSeconds = 0;

// Google Meet stream state
let gmeetStream = null;
let gmeetRecorder = null;
let gmeetChunks = [];
let gmeetTimerInterval = null;
let gmeetSeconds = 0;

// DOM Elements
const statusGemma = document.getElementById('status-gemma');
const statusEleven = document.getElementById('status-elevenlabs');
const userNameInput = document.getElementById('user-name');
const voiceSelect = document.getElementById('voice-select');
const btnProcess = document.getElementById('btn-process');
const progressContainer = document.getElementById('progress-container');
const progressStatusText = document.getElementById('progress-status-text');
const resultsContainer = document.getElementById('results-container');
const samplePreviewText = document.getElementById('sample-preview-text');

// Google Meet DOM elements
const btnGmeetConnect = document.getElementById('btn-gmeet-connect');
const gmeetBtnText = document.getElementById('gmeet-btn-text');
const gmeetLiveBar = document.getElementById('gmeet-live-bar');
const gmeetTimer = document.getElementById('gmeet-timer');
const gmeetWaveform = document.getElementById('gmeet-waveform');

// Audio players
const audioDebrief = document.getElementById('audio-player-debrief');
const btnPlayDebrief = document.getElementById('btn-play-debrief');
const playBtnText = document.getElementById('play-btn-text');
const audioWave = document.querySelector('.audio-wave');

const audioSurrogate = document.getElementById('audio-player-surrogate');
const btnPlaySurrogate = document.getElementById('btn-play-surrogate');

// Class Representative (CR) WhatsApp Broadcast DOM elements
const audioCr = document.getElementById('audio-player-cr');
const btnPlayCr = document.getElementById('btn-play-cr');
const crPlayBtnText = document.getElementById('cr-play-btn-text');
const btnDownloadCrAudio = document.getElementById('btn-download-cr-audio');
const crVoiceScriptText = document.getElementById('cr-voice-script-text');
const crWhatsappText = document.getElementById('cr-whatsapp-text');
const btnCopyCrText = document.getElementById('btn-copy-cr-text');
const btnShareWhatsapp = document.getElementById('btn-share-whatsapp');

// PDF Handout upload elements
let selectedPdfFile = null;
const pdfFileInput = document.getElementById('pdf-file-input');
const pdfFileName = document.getElementById('pdf-file-name');
const btnRemovePdf = document.getElementById('btn-remove-pdf');

/**
 * Initialize application
 */
async function init() {
  if (window.mermaid) {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      themeVariables: {
        darkMode: true,
        primaryColor: '#6366f1',
        primaryTextColor: '#f8fafc',
        primaryBorderColor: '#818cf8',
        lineColor: '#14b8a6',
        secondaryColor: '#1e293b',
        tertiaryColor: '#0f172a'
      }
    });
  }
  await checkHealth();
  await loadVoices();
  await loadSamples();
  setupEventListeners();
  await initAnnouncementsHub();
}

/**
 * Check backend and AI model health
 */
async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();

    if (data.ollamaConnected && data.gemmaAvailable) {
      statusGemma.className = 'pill pill-online';
      statusGemma.innerHTML = `<span class="pill-dot"></span> Gemma 3:4B (Local CPU)`;
    } else if (data.ollamaConnected) {
      statusGemma.className = 'pill pill-offline';
      statusGemma.innerHTML = `<span class="pill-dot"></span> Ollama Online (${data.model})`;
    } else {
      statusGemma.className = 'pill pill-offline';
      statusGemma.innerHTML = `<span class="pill-dot"></span> Ollama Offline`;
    }

    if (data.elevenLabsConfigured) {
      statusEleven.className = 'pill pill-online';
      statusEleven.innerHTML = `<span class="pill-dot"></span> ElevenLabs Flash v2.5`;
    } else {
      statusEleven.className = 'pill pill-offline';
      statusEleven.innerHTML = `<span class="pill-dot"></span> ElevenLabs (Add Key to .env)`;
    }
  } catch (err) {
    console.error('Health check failed:', err);
  }
}

/**
 * Load available voices from ElevenLabs
 */
async function loadVoices() {
  try {
    const res = await fetch('/api/voices');
    const voices = await res.json();
    if (voices && voices.length > 0) {
      voiceSelect.innerHTML = voices.map(v => 
        `<option value="${v.voice_id}" ${v.voice_id === 'PIzF7N4AZiqRy5BOSpFC' ? 'selected' : ''}>${v.name}</option>`
      ).join('');
    }
  } catch (err) {
    console.warn('Could not load ElevenLabs voices:', err);
  }
}

/**
 * Load sample scenarios
 */
async function loadSamples() {
  try {
    const res = await fetch('/api/samples');
    sampleScenarios = await res.json();
    updateSamplePreview();
  } catch (err) {
    console.error('Failed to load sample scenarios:', err);
  }
}

function updateSamplePreview() {
  if (sampleScenarios[activeSampleKey]) {
    samplePreviewText.textContent = sampleScenarios[activeSampleKey].transcript;
  }
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
  // Tabs
  document.getElementById('tab-gmeet').addEventListener('click', () => switchTab('gmeet'));
  document.getElementById('tab-sample').addEventListener('click', () => switchTab('sample'));
  document.getElementById('tab-mic').addEventListener('click', () => switchTab('mic'));
  document.getElementById('tab-custom').addEventListener('click', () => switchTab('custom'));
  const tabAutoCr = document.getElementById('tab-auto-cr');
  if (tabAutoCr) {
    tabAutoCr.addEventListener('click', () => switchTab('auto-cr'));
  }

  // Auto-CR Presets
  document.querySelectorAll('.autocr-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.autocr-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const senderInput = document.getElementById('autocr-sender-name');
      const msgInput = document.getElementById('autocr-incoming-msg');
      if (senderInput) senderInput.value = btn.dataset.name;
      if (msgInput) msgInput.value = btn.dataset.msg;
    });
  });

  const btnTriggerAutoCr = document.getElementById('btn-trigger-autocr');
  if (btnTriggerAutoCr) {
    btnTriggerAutoCr.addEventListener('click', handleAutoCrDispatch);
  }

  const btnScanWhatsapp = document.getElementById('btn-scan-whatsapp');
  if (btnScanWhatsapp) {
    btnScanWhatsapp.addEventListener('click', async () => {
      btnScanWhatsapp.disabled = true;
      btnScanWhatsapp.innerHTML = '<span>⏳</span> Scanning WhatsApp Web...';
      try {
        const res = await fetch('/api/browserbase/scan-chats');
        const data = await res.json();
        if (data.chats && data.chats.length > 0) {
          const firstChat = data.chats[0];
          const senderInput = document.getElementById('autocr-sender-name');
          const msgInput = document.getElementById('autocr-incoming-msg');
          if (senderInput) senderInput.value = firstChat.contact;
          if (msgInput) msgInput.value = firstChat.lastMessage;
          alert(`📲 WhatsApp Web Scan Complete via Browserbase!\n\nIncoming DM detected from ${firstChat.contact}:\n"${firstChat.lastMessage}"\n\nClick "Dispatch Auto-Reply via Browserbase Cloud" to search your laptop and deliver the notes + cloned voice note!`);
        }
      } catch (err) {
        alert('Scan notice: ' + err.message);
      } finally {
        btnScanWhatsapp.disabled = false;
        btnScanWhatsapp.innerHTML = '<span>🔍</span> Scan WhatsApp Chats';
      }
    });
  }

  const btnLinkWhatsapp = document.getElementById('btn-link-whatsapp');
  if (btnLinkWhatsapp) {
    btnLinkWhatsapp.addEventListener('click', async () => {
      btnLinkWhatsapp.disabled = true;
      btnLinkWhatsapp.innerHTML = '<span>⏳</span> Opening Cloud WhatsApp...';
      try {
        const res = await fetch('/api/browserbase/link-device', { method: 'POST' });
        const data = await res.json();
        if (data.liveUrl) {
          window.open(data.liveUrl, '_blank');
          alert('☁️ Browserbase is now running WhatsApp Web in the cloud!\n\nA new tab has opened with your live cloud browser session.\n\nScan the QR code once with your phone (WhatsApp > Settings > Linked Devices > Link a Device).\n\nOnce scanned, Browserbase stays permanently linked to your WhatsApp in the cloud!');
        } else {
          alert('Could not launch linking session: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Error launching linking session: ' + err.message);
      } finally {
        btnLinkWhatsapp.disabled = false;
        btnLinkWhatsapp.innerHTML = '<span>🔗</span> Link Device (Scan QR)';
      }
    });
  }

  // Google Meet Tab Connect
  btnGmeetConnect.addEventListener('click', toggleGoogleMeet);

  // Sample cards
  document.querySelectorAll('.sample-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.sample-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      activeSampleKey = card.dataset.sample;
      updateSamplePreview();
    });
  });

  // Mic Record
  micBtn.addEventListener('click', toggleRecording);

  // PDF File Attachment (PyMuPDF ingestion)
  pdfFileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      selectedPdfFile = e.target.files[0];
      pdfFileName.textContent = `Attached: ${selectedPdfFile.name} (${Math.round(selectedPdfFile.size / 1024)} KB)`;
      btnRemovePdf.style.display = 'inline-block';
    }
  });

  btnRemovePdf.addEventListener('click', (e) => {
    e.preventDefault();
    selectedPdfFile = null;
    pdfFileInput.value = '';
    pdfFileName.textContent = 'Attach Lecture Slides / Textbook PDF (Optional: PyMuPDF extracts equations & text)';
    btnRemovePdf.style.display = 'none';
  });

  // THE ONE BIG BUTTON
  btnProcess.addEventListener('click', processMeeting);

  // Audio Playback
  btnPlayDebrief.addEventListener('click', toggleDebriefAudio);
  audioDebrief.addEventListener('play', () => {
    playBtnText.textContent = 'Pause Debrief';
    audioWave.classList.add('playing');
  });
  audioDebrief.addEventListener('pause', () => {
    playBtnText.textContent = 'Listen to Debrief';
    audioWave.classList.remove('playing');
  });
  audioDebrief.addEventListener('ended', () => {
    playBtnText.textContent = 'Listen Again';
    audioWave.classList.remove('playing');
  });

  // Surrogate Voice Playback
  btnPlaySurrogate.addEventListener('click', () => {
    if (audioSurrogate.paused) {
      audioSurrogate.play();
      btnPlaySurrogate.textContent = '⏸️ Playing Voice...';
    } else {
      audioSurrogate.pause();
      btnPlaySurrogate.textContent = '🔊 Hear Your Cloned Voice';
    }
  });
  audioSurrogate.addEventListener('ended', () => {
    btnPlaySurrogate.textContent = '🔊 Hear Your Cloned Voice';
  });

  // Class Representative (CR) Audio & WhatsApp Actions
  if (btnPlayCr) {
    btnPlayCr.addEventListener('click', () => {
      if (!audioCr.src) return;
      if (audioCr.paused) {
        audioCr.play();
      } else {
        audioCr.pause();
      }
    });

    audioCr.addEventListener('play', () => {
      btnPlayCr.classList.add('playing');
      crPlayBtnText.textContent = 'Pause Voice Note';
    });
    audioCr.addEventListener('pause', () => {
      btnPlayCr.classList.remove('playing');
      crPlayBtnText.textContent = 'Listen to Class Voice Note';
    });
    audioCr.addEventListener('ended', () => {
      btnPlayCr.classList.remove('playing');
      crPlayBtnText.textContent = 'Listen Again';
    });
  }

  if (btnCopyCrText) {
    btnCopyCrText.addEventListener('click', () => {
      const text = crWhatsappText.textContent;
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        const original = btnCopyCrText.textContent;
        btnCopyCrText.textContent = '✅ Copied!';
        setTimeout(() => { btnCopyCrText.textContent = original; }, 2000);
      });
    });
  }

  if (btnShareWhatsapp) {
    btnShareWhatsapp.addEventListener('click', (e) => {
      const text = crWhatsappText.textContent;
      if (!text) {
        e.preventDefault();
        return;
      }
      navigator.clipboard.writeText(text).catch(() => {});
    });
  }

  const btnShareWaApp = document.getElementById('btn-share-whatsapp-app');
  if (btnShareWaApp) {
    btnShareWaApp.addEventListener('click', (e) => {
      const text = crWhatsappText.textContent;
      if (!text) {
        e.preventDefault();
        return;
      }
      navigator.clipboard.writeText(text).catch(() => {});
    });
  }
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

  document.getElementById(`tab-${tab}`).classList.add('active');
  document.getElementById(`panel-${tab}`).classList.add('active');
}

/**
 * Handle Google Meet Tab Recording
 */
async function toggleGoogleMeet() {
  if (gmeetStream && gmeetRecorder && gmeetRecorder.state === 'recording') {
    // User clicked Stop & Debrief Me
    stopGoogleMeet();
    // Wait briefly for last audio chunk
    setTimeout(() => {
      processMeeting();
    }, 300);
  } else {
    try {
      // Prompt Chrome screen/tab picker
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      const audioTracks = stream.getAudioTracks();
      if (!audioTracks || audioTracks.length === 0) {
        alert("⚠️ No tab audio detected!\n\nPlease make sure to check 'Also share tab audio' in Chrome's tab selector.");
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      gmeetStream = stream;
      gmeetChunks = [];
      const audioStream = new MediaStream([audioTracks[0]]);
      gmeetRecorder = new MediaRecorder(audioStream);

      gmeetRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) gmeetChunks.push(e.data);
      };

      gmeetRecorder.onstop = () => {
        recordedAudioBlob = new Blob(gmeetChunks, { type: 'audio/webm' });
      };

      gmeetRecorder.start(1000);

      // UI state
      btnGmeetConnect.classList.add('recording');
      gmeetBtnText.textContent = '⏹️ Stop Google Meet & Debrief Me';
      gmeetLiveBar.style.display = 'flex';
      gmeetWaveform.classList.add('active');

      gmeetSeconds = 0;
      gmeetTimer.textContent = '00:00';
      gmeetTimerInterval = setInterval(() => {
        gmeetSeconds++;
        const mins = String(Math.floor(gmeetSeconds / 60)).padStart(2, '0');
        const secs = String(gmeetSeconds % 60).padStart(2, '0');
        gmeetTimer.textContent = `${mins}:${secs}`;
      }, 1000);

      // Listen for when tab sharing is stopped by user
      audioTracks[0].onended = () => {
        if (gmeetRecorder && gmeetRecorder.state === 'recording') {
          stopGoogleMeet();
          setTimeout(() => { processMeeting(); }, 300);
        }
      };

    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        alert(`Google Meet capture error: ${err.message}`);
        console.error(err);
      }
    }
  }
}

function stopGoogleMeet() {
  if (gmeetRecorder && gmeetRecorder.state === 'recording') {
    gmeetRecorder.stop();
  }
  if (gmeetStream) {
    gmeetStream.getTracks().forEach(track => track.stop());
    gmeetStream = null;
  }
  clearInterval(gmeetTimerInterval);
  btnGmeetConnect.classList.remove('recording');
  gmeetBtnText.textContent = '🔴 Connect to Google Meet Tab';
  gmeetWaveform.classList.remove('active');
}

/**
 * Handle Microphone Recording
 */
async function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    // Stop recording
    mediaRecorder.stop();
    micBtn.classList.remove('recording');
    micStatusLabel.textContent = 'Recording finished! Ready to process.';
    clearInterval(recordTimerInterval);
  } else {
    // Start recording
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        recordedAudioBlob = new Blob(recordedChunks, { type: 'audio/webm' });
        const audioUrl = URL.createObjectURL(recordedAudioBlob);
        recordedAudioPlayback.src = audioUrl;
        recordedAudioPlayback.style.display = 'block';
      };

      mediaRecorder.start();
      micBtn.classList.add('recording');
      micStatusLabel.textContent = 'Recording in progress... speak now';
      recordSeconds = 0;
      micTimer.textContent = '00:00';
      recordTimerInterval = setInterval(() => {
        recordSeconds++;
        const mins = String(Math.floor(recordSeconds / 60)).padStart(2, '0');
        const secs = String(recordSeconds % 60).padStart(2, '0');
        micTimer.textContent = `${mins}:${secs}`;
      }, 1000);

    } catch (err) {
      alert('Microphone access denied or not supported in this browser.');
      console.error(err);
    }
  }
}

/**
 * Main Process Meeting Execution (Audio -> Transcript -> Gemma -> ElevenLabs -> One Button)
 */
async function processMeeting() {
  const userName = userNameInput.value.trim() || 'Karthik';
  const voiceId = voiceSelect.value;

  btnProcess.disabled = true;
  resultsContainer.style.display = 'none';
  progressContainer.style.display = 'block';

  setStep(1, 'Audio stream captured...');

  const formData = new FormData();
  formData.append('userName', userName);
  formData.append('voiceId', voiceId);

  if ((currentTab === 'gmeet' || currentTab === 'mic') && recordedAudioBlob) {
    formData.append('audio', recordedAudioBlob, 'meeting-recording.webm');
  } else if (currentTab === 'custom') {
    const text = document.getElementById('custom-transcript-text').value.trim();
    if (!text) {
      alert('Please enter a transcript to process.');
      resetProgress();
      return;
    }
    formData.append('transcript', text);
  } else {
    // Sample tab or fallback
    const sample = sampleScenarios[activeSampleKey];
    formData.append('transcript', sample ? sample.transcript : '');
  }

  // Append optional attached PDF (PyMuPDF ingestion)
  if (selectedPdfFile) {
    formData.append('pdf', selectedPdfFile, selectedPdfFile.name);
  }

  try {
    setStep(2, 'Local Gemma 3:4B is analyzing transcript & checking for your name...');

    const response = await fetch('/api/process-meeting', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || 'Server error processing meeting');
    }

    setStep(3, 'ElevenLabs is generating spoken debrief audio...');

    const result = await response.json();
    renderResults(result);

  } catch (error) {
    alert(`Error: ${error.message}`);
    console.error(error);
  } finally {
    resetProgress();
  }
}

function setStep(stepNum, statusText) {
  progressStatusText.textContent = statusText;
  document.querySelectorAll('.step-item').forEach((item, idx) => {
    if (idx + 1 <= stepNum) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
}

function resetProgress() {
  btnProcess.disabled = false;
  progressContainer.style.display = 'none';
}

/**
 * Render the final results
 */
function renderResults(data) {
  const { analysis, audio, transcript, userName } = data;

  // 1. Spoken Debrief Section
  document.getElementById('debrief-script-text').textContent = analysis.spokendebriefScript;
  if (audio && audio.debriefUrl) {
    audioDebrief.src = audio.debriefUrl;
    btnPlayDebrief.style.display = 'inline-flex';
    audioDebrief.play().catch(e => console.log('Autoplay prevented by browser:', e));
  } else if (audio && audio.error) {
    btnPlayDebrief.onclick = () => {
      const utterance = new SpeechSynthesisUtterance(analysis.spokendebriefScript);
      window.speechSynthesis.speak(utterance);
    };
  }

  // 2. Visual Architecture & Mechanism Diagram
  document.getElementById('lecture-title-heading').textContent = analysis.lectureTitle || analysis.meetingTitle || 'Lecture Analysis';
  document.getElementById('topic-category-tag').textContent = analysis.topicCategory || 'Engineering';
  document.getElementById('concept-overview-text').textContent = analysis.conceptOverview || '';

  const renderArea = document.getElementById('mermaid-render-area');
  if (analysis.mermaidDiagram && window.mermaid) {
    const cleanDiagram = analysis.mermaidDiagram.trim();
    const diagramId = 'mermaid-svg-' + Math.floor(Math.random() * 100000);
    try {
      mermaid.render(diagramId, cleanDiagram).then(({ svg }) => {
        renderArea.innerHTML = svg;
      }).catch(err => {
        console.warn('Mermaid syntax issue:', err);
        renderArea.innerHTML = `<pre style="font-family: monospace; font-size: 0.85rem; color: #a5b4fc; text-align: left;">${cleanDiagram}</pre>`;
      });
    } catch (e) {
      renderArea.innerHTML = `<pre style="font-family: monospace; font-size: 0.85rem; color: #a5b4fc; text-align: left;">${cleanDiagram}</pre>`;
    }
  }

  // 3. Formulas & Technical Principles
  const formulasCard = document.getElementById('formulas-card');
  const formulasGrid = document.getElementById('formulas-grid');
  if (analysis.formulasAndTerms && analysis.formulasAndTerms.length > 0) {
    formulasGrid.innerHTML = analysis.formulasAndTerms.map(f => `
      <div class="formula-item">
        <div class="formula-name">${f.name}</div>
        <div class="formula-code">${f.formula}</div>
        <div class="formula-significance">${f.significance}</div>
      </div>
    `).join('');
    formulasCard.style.display = 'block';
  } else {
    formulasCard.style.display = 'none';
  }

  // 4. Core Principles & Action Items
  const listPrinciples = document.getElementById('list-principles');
  listPrinciples.innerHTML = (analysis.keyPrinciples || analysis.keyDecisions || []).map(p => `<li>${p}</li>`).join('');

  const listActions = document.getElementById('list-actions');
  listActions.innerHTML = (analysis.urgentActionItems || []).map(item => `<li>${item}</li>`).join('');

  // 5. Surrogate Name Trigger Card
  const alertCard = document.getElementById('surrogate-alert-card');
  const headline = document.getElementById('surrogate-headline');
  const detail = document.getElementById('surrogate-detail-text');
  const replyWrap = document.getElementById('surrogate-reply-wrap');
  const replyText = document.getElementById('surrogate-reply-text');
  const icon = document.getElementById('surrogate-icon');

  if (analysis.attendanceOrNameCalled) {
    alertCard.className = 'surrogate-card';
    icon.textContent = '🚨';
    headline.textContent = `Name Called: Surrogate Auto-Responded!`;
    detail.textContent = analysis.nameTriggerDetail;
    replyText.textContent = `"${analysis.surrogateAutoReply}"`;
    replyWrap.style.display = 'block';

    if (audio && audio.surrogateUrl) {
      audioSurrogate.src = audio.surrogateUrl;
      btnPlaySurrogate.style.display = 'inline-block';
    } else {
      btnPlaySurrogate.style.display = 'none';
    }
  } else {
    alertCard.className = 'surrogate-card clear';
    icon.textContent = '✅';
    headline.textContent = `Attendance Clear: No Direct Callouts`;
    detail.textContent = `Your name (${userName}) was not singled out. You can stay asleep with zero worries.`;
    replyWrap.style.display = 'none';
  }

  // 5b. Class Representative (CR) WhatsApp Voice Broadcast
  if (analysis.crBroadcast) {
    const rawWaText = analysis.crBroadcast.whatsappText || '';
    if (crVoiceScriptText) {
      crVoiceScriptText.textContent = `"${analysis.crBroadcast.voiceScript || ''}"`;
    }
    if (crWhatsappText) {
      crWhatsappText.textContent = rawWaText;
    }

    // Set pre-filled WhatsApp links
    const encodedText = encodeURIComponent(rawWaText);
    if (btnShareWhatsapp) {
      btnShareWhatsapp.href = `https://web.whatsapp.com/send?text=${encodedText}`;
    }
    const btnShareWaApp = document.getElementById('btn-share-whatsapp-app');
    if (btnShareWaApp) {
      btnShareWaApp.href = `whatsapp://send?text=${encodedText}`;
    }

    if (audio && audio.crBroadcastUrl) {
      audioCr.src = audio.crBroadcastUrl;
      btnPlayCr.style.display = 'inline-flex';
      btnDownloadCrAudio.href = audio.crBroadcastUrl;
      btnDownloadCrAudio.style.display = 'inline-flex';
    } else {
      btnPlayCr.style.display = 'none';
      btnDownloadCrAudio.style.display = 'none';
    }
  }

  // 6. Export to Google Docs
  document.getElementById('btn-export-docs').onclick = () => {
    const docTitle = analysis.lectureTitle || 'Lecture Notes';
    const textContent = `${docTitle}\nCategory: ${analysis.topicCategory || 'General'}\nDate: ${new Date().toLocaleDateString()}\n\n=== SPOKEN VOICE SUMMARY ===\n${analysis.spokendebriefScript}\n\n=== CONCEPT OVERVIEW ===\n${analysis.conceptOverview || ''}\n\n=== KEY PRINCIPLES ===\n${(analysis.keyPrinciples || []).map(p => '• ' + p).join('\n')}\n\n=== FORMULAS & DEFINITIONS ===\n${(analysis.formulasAndTerms || []).map(f => `${f.name}: ${f.formula} (${f.significance})`).join('\n')}\n\n=== DEADLINES & EXAM WATCHOUTS ===\n${(analysis.urgentActionItems || []).map(a => '• ' + a).join('\n')}`;

    navigator.clipboard.writeText(textContent).then(() => {
      alert("📋 Lecture notes copied to clipboard!\n\nOpening Google Docs in a new tab... Press Cmd+V (or Ctrl+V) to paste!");
      window.open('https://docs.new', '_blank');
    }).catch(() => {
      window.open('https://docs.new', '_blank');
    });
  };

  // 7. Add to Google Calendar
  document.getElementById('btn-add-calendar').onclick = () => {
    const title = encodeURIComponent(`[Exam/Deadline] ${analysis.lectureTitle || 'Course Task'}`);
    const details = encodeURIComponent(`Key Tasks:\n${(analysis.urgentActionItems || []).join('\n')}\n\nSummary:\n${analysis.spokendebriefScript}`);
    // Open Google Calendar event creation
    const calUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&details=${details}`;
    window.open(calUrl, '_blank');
  };

  // 8. Download Illustrated Study PDF
  document.getElementById('btn-download-pdf').onclick = () => {
    window.print();
  };

  // 9. Full Raw Transcript
  document.getElementById('full-transcript-view').textContent = transcript;

  resultsContainer.style.display = 'block';
  resultsContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toggleDebriefAudio() {
  if (audioDebrief.paused) {
    audioDebrief.play();
  } else {
    audioDebrief.pause();
  }
}

async function handleAutoCrDispatch() {
  const senderName = document.getElementById('autocr-sender-name').value.trim() || 'Classmate';
  const incomingMessage = document.getElementById('autocr-incoming-msg').value.trim();
  const btnTrigger = document.getElementById('btn-trigger-autocr');
  const resultCard = document.getElementById('autocr-result-card');
  const sessionLink = document.getElementById('autocr-session-link');
  const audioPlayer = document.getElementById('autocr-audio-player');
  const sentText = document.getElementById('autocr-sent-text');
  const attachedPdf = document.getElementById('autocr-attached-pdf');

  if (!incomingMessage) {
    alert('Please enter an incoming WhatsApp message.');
    return;
  }

  btnTrigger.disabled = true;
  btnTrigger.innerHTML = '<span>⚡</span> Generating Cloned Voice & Fetching Materials...';

  try {
    const res = await fetch('/api/telegram/test-dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        senderName,
        incomingMessage,
        userName: userNameInput ? userNameInput.value : 'Karthik',
        voiceId: voiceSelect ? voiceSelect.value : undefined
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to dispatch auto-reply');

    // Display output card
    resultCard.style.display = 'block';
    sentText.textContent = data.replyMessage;

    if (data.voiceNoteUrl) {
      audioPlayer.src = data.voiceNoteUrl;
      audioPlayer.play().catch(() => {});
    }

    if (data.driveUrl) {
      attachedPdf.innerHTML = `<a href="${data.driveUrl}" target="_blank" rel="noopener noreferrer" style="color:#38bdf8; text-decoration:underline; font-weight:600;">${data.matchedTopic} (Open in Drive ↗)</a>`;
    } else if (data.pdfAttached) {
      attachedPdf.textContent = `${data.pdfAttached} (${data.matchedTopic || 'Materials'})`;
    } else {
      attachedPdf.textContent = data.matchedTopic || 'Course Materials';
    }

    resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    alert(`StandIn Error: ${err.message}`);
  } finally {
    btnTrigger.disabled = false;
    btnTrigger.innerHTML = '<span>⚡</span> Dispatch Autonomous Response (Voice Note + Drive Link)';
  }
}

/* ============================================================
   📢 CR ANNOUNCEMENTS & DEADLINE HUB LOGIC
   ============================================================ */
let currentAnnouncementsFilter = 'all';

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function initAnnouncementsHub() {
  const tabAnn = document.getElementById('tab-announcements');
  if (tabAnn) {
    tabAnn.addEventListener('click', () => switchTab('announcements'));
  }

  // Quick template chips
  document.querySelectorAll('.ann-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const titleInput = document.getElementById('ann-input-title');
      const textInput = document.getElementById('ann-input-text');
      if (titleInput && chip.dataset.title) titleInput.value = chip.dataset.title;
      if (textInput && chip.dataset.text) textInput.value = chip.dataset.text;
    });
  });

  // Filter pills
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentAnnouncementsFilter = btn.dataset.filter;
      loadAnnouncementsFeed(currentAnnouncementsFilter);
    });
  });

  // Publish Voice Announcement button
  const btnPublishVoice = document.getElementById('btn-publish-voice-ann');
  if (btnPublishVoice) {
    btnPublishVoice.addEventListener('click', () => handlePublishAnnouncement(true));
  }

  // Save Draft button
  const btnSaveDraft = document.getElementById('btn-save-draft-ann');
  if (btnSaveDraft) {
    btnSaveDraft.addEventListener('click', () => handlePublishAnnouncement(false));
  }

  // Load initial feed
  await loadAnnouncementsFeed('all');
}

async function loadAnnouncementsFeed(filter = 'all') {
  const feed = document.getElementById('announcements-feed');
  const countBadge = document.getElementById('ann-count-badge');
  if (!feed) return;

  try {
    const res = await fetch('/api/announcements');
    const data = await res.json();
    const items = data.announcements || [];

    const filtered = items.filter(item => {
      if (filter === 'all') return true;
      return item.status === filter;
    });

    if (countBadge) {
      countBadge.textContent = `${items.length} notice${items.length === 1 ? '' : 's'}`;
    }

    if (filtered.length === 0) {
      feed.innerHTML = `
        <div style="text-align: center; padding: 32px 16px; color: var(--text-dim); background: rgba(255,255,255,0.02); border: 1px dashed var(--bg-card-border); border-radius: var(--radius-md);">
          <span>📭 No ${filter === 'all' ? '' : filter.toLowerCase() + ' '}notices posted yet. Use the composer above to broadcast!</span>
        </div>
      `;
      return;
    }

    feed.innerHTML = filtered.map(item => {
      const isLive = item.status === 'Active' || !item.status;
      const dateStr = item.createdAt ? new Date(item.createdAt).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }) : 'Recently';

      return `
        <div class="ann-item-card" id="ann-card-${item.id}">
          <div class="ann-item-top">
            <div>
              <h4 class="ann-item-title">${escapeHtml(item.title || 'Class Notice')}</h4>
              <div class="ann-item-meta">By ${escapeHtml(item.author || 'CR Karthik')} • <span>${dateStr}</span></div>
            </div>
            <span class="ann-status-pill ${isLive ? 'status-active' : 'status-draft'}">
              ${isLive ? '🟢 Active in Bot Memory' : '🟡 Staged Draft'}
            </span>
          </div>

          <div class="ann-item-body">
            "${escapeHtml(item.rawText || item.text || '')}"
          </div>

          ${item.voiceUrl ? `
            <div class="ann-item-audio-row">
              <audio controls src="${item.voiceUrl}" style="width: 100%; height: 38px;"></audio>
            </div>
          ` : ''}

          <div class="ann-item-actions">
            ${isLive ? `
              <button type="button" class="ann-action-btn btn-toggle-draft" onclick="window.toggleAnnStatus('${item.id}', 'Draft')">
                ⏸️ Set to Staged Draft
              </button>
            ` : `
              <button type="button" class="ann-action-btn btn-toggle-active" onclick="window.toggleAnnStatus('${item.id}', 'Active')">
                🚀 Activate in Bot Memory
              </button>
            `}

            <button type="button" class="ann-action-btn" onclick="window.testAnnInBot('${escapeHtml(item.rawText || '').replace(/'/g, "\\'")}')">
              ✈️ Test in Telegram Bot
            </button>

            <button type="button" class="ann-action-btn btn-delete" onclick="window.deleteAnnItem('${item.id}')">
              🗑️ Delete
            </button>
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    feed.innerHTML = `<div style="color: #fda4af; padding: 12px;">Failed to load announcements: ${err.message}</div>`;
  }
}

async function handlePublishAnnouncement(withVoice = true) {
  const titleInput = document.getElementById('ann-input-title');
  const textInput = document.getElementById('ann-input-text');
  const statusSelect = document.getElementById('ann-input-status');
  const btnPublish = document.getElementById('btn-publish-voice-ann');
  const voiceCard = document.getElementById('ann-live-voice-card');
  const liveAudio = document.getElementById('ann-live-audio');
  const liveScript = document.getElementById('ann-live-script');
  const voiceSelect = document.getElementById('voice-select');

  const title = titleInput ? titleInput.value.trim() : 'Class Announcement';
  const text = textInput ? textInput.value.trim() : '';
  const status = withVoice ? (statusSelect ? statusSelect.value : 'Active') : 'Draft';

  if (!text) {
    alert('Please paste or enter the announcement notice text.');
    return;
  }

  if (btnPublish) {
    btnPublish.disabled = true;
    btnPublish.innerHTML = withVoice 
      ? '<span>⏳</span> Generating Cloned Voice via ElevenLabs...' 
      : '<span>⏳</span> Saving Draft...';
  }

  try {
    const res = await fetch('/api/announcements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        text,
        status,
        author: 'CR Karthik',
        voiceId: voiceSelect ? voiceSelect.value : undefined
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to post announcement');

    if (data.voiceNoteUrl && voiceCard && liveAudio) {
      voiceCard.style.display = 'block';
      liveAudio.src = data.voiceNoteUrl;
      liveAudio.play().catch(() => {});
      if (liveScript) liveScript.textContent = `"${data.voiceScript}"`;
    }

    await loadAnnouncementsFeed(currentAnnouncementsFilter);

  } catch (err) {
    alert('Announcement Error: ' + err.message);
  } finally {
    if (btnPublish) {
      btnPublish.disabled = false;
      btnPublish.innerHTML = '<span>🎙️</span> Synthesize Cloned Voice & Post Announcement';
    }
  }
}

// Global helpers for inline action buttons
window.toggleAnnStatus = async function(id, newStatus) {
  try {
    const res = await fetch(`/api/announcements/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    if (res.ok) {
      await loadAnnouncementsFeed(currentAnnouncementsFilter);
    }
  } catch (err) {
    alert('Status update error: ' + err.message);
  }
};

window.deleteAnnItem = async function(id) {
  if (!confirm('Are you sure you want to remove this notice from memory?')) return;
  try {
    const res = await fetch(`/api/announcements/${id}`, { method: 'DELETE' });
    if (res.ok) {
      await loadAnnouncementsFeed(currentAnnouncementsFilter);
    }
  } catch (err) {
    alert('Delete error: ' + err.message);
  }
};

window.testAnnInBot = function(text) {
  switchTab('auto-cr');
  const msgInput = document.getElementById('autocr-incoming-msg');
  if (msgInput) {
    if (text.includes('lecture') || text.includes('Room')) {
      msgInput.value = 'what room is tomorrow lecture?';
    } else if (text.includes('deadline') || text.includes('extended')) {
      msgInput.value = 'when is lab report due?';
    } else {
      msgInput.value = 'any class announcements?';
    }
  }
  const triggerBtn = document.getElementById('btn-trigger-autocr');
  if (triggerBtn) triggerBtn.focus();
};

// Start app
window.addEventListener('DOMContentLoaded', init);

