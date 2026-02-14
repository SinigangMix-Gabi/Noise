/**
 * app.js
 * ─────────────────────────────────────────────────────────
 * Brown Noise Focus Station — UI Controller
 *
 * FIXES vs v1:
 *   • Resize: ctx2d.setTransform() replaces scale() — no accumulation
 *   • Removed audioEngine._ctx access — uses getSampleRate() instead
 *   • Volume fill is now honest (linear, matches linear gain)
 *
 * NEW:
 *   • Fade in/out handled by engine; UI updates immediately
 *   • Presets: Deep / Flow / Light
 *   • Color slider live readout label
 *   • Waveform ↔ Bars visualizer toggle (click the button)
 *   • Spacebar keyboard shortcut for play/pause
 *   • localStorage — persists volume, filter, active preset
 *   • AudioContext error shown in overlay
 * ─────────────────────────────────────────────────────────
 */

import { audioEngine } from './audio-engine.js';

/* ═══════════════════════════════════════════════════════════
   DOM REFS
   ═══════════════════════════════════════════════════════════ */
const playBtn = document.getElementById('play-btn');
const iconPlay = document.getElementById('icon-play');
const iconPause = document.getElementById('icon-pause');
const statusText = document.getElementById('status-text');
const volumeSlider = document.getElementById('volume-slider');
const colorSlider = document.getElementById('color-slider');
const colorReadout = document.getElementById('color-readout');
const canvas = document.getElementById('visualizer-canvas');
const ctx2d = canvas.getContext('2d');
const errorOverlay = document.getElementById('error-overlay');
const errorMessage = document.getElementById('error-message');
const viewToggleBtn = document.getElementById('view-toggle-btn');
const vtBarsIcon = viewToggleBtn.querySelector('.vt-bars');
const vtWaveIcon = viewToggleBtn.querySelector('.vt-wave');
const presetBtns = document.querySelectorAll('.preset-btn');

/* ═══════════════════════════════════════════════════════════
   PRESETS
   ═══════════════════════════════════════════════════════════ */
const PRESETS = {
    deep: { volume: 0.55, filterFreq: 200 },  // sub-heavy brown
    flow: { volume: 0.65, filterFreq: 550 },  // balanced default
    light: { volume: 0.50, filterFreq: 1800 },  // softer, airier
};

/* ═══════════════════════════════════════════════════════════
   COLOR READOUT — maps Hz to a human label
   ═══════════════════════════════════════════════════════════ */
function getColorLabel(hz) {
    if (hz < 300) return 'Deep Brown';
    if (hz < 700) return 'Warm Brown';
    if (hz < 1200) return 'Amber';
    if (hz < 2200) return 'Soft White';
    return 'Near White';
}

/* ═══════════════════════════════════════════════════════════
   SLIDER FILL HELPER
   Sets the CSS --fill custom property so the filled portion
   of the track always matches the thumb position.
   Both volume and color use a straight linear fill — honest
   visual representation of the underlying linear gain.
   ═══════════════════════════════════════════════════════════ */
function updateSliderFill(slider, value, min, max) {
    const pct = ((value - min) / (max - min)) * 100;
    slider.style.setProperty('--fill', `${pct.toFixed(2)}%`);
}

/* ═══════════════════════════════════════════════════════════
   LOCALSTORAGE
   ═══════════════════════════════════════════════════════════ */
const LS_KEY = 'bnfs_state';

function loadSavedState() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (_) {
        return null;
    }
}

function persistState(extra = {}) {
    try {
        const s = audioEngine.getState();
        localStorage.setItem(LS_KEY, JSON.stringify({ ...s, ...extra }));
    } catch (_) { /* storage unavailable — fail silently */ }
}

/* ═══════════════════════════════════════════════════════════
   ERROR DISPLAY
   ═══════════════════════════════════════════════════════════ */
function showError(msg) {
    errorMessage.textContent = msg;
    errorOverlay.hidden = false;
}

/* ═══════════════════════════════════════════════════════════
   INIT — apply saved or default state to sliders
   ═══════════════════════════════════════════════════════════ */
(function applyInitialState() {
    const saved = loadSavedState();

    const volume = saved?.volume ?? 0.6;
    const filterHz = saved?.filterFreq ?? 400;
    const preset = saved?.preset ?? null;

    // Sync engine
    audioEngine.setState({ volume, filterFreq: filterHz });

    // Sync sliders
    volumeSlider.value = String(volume);
    colorSlider.value = String(filterHz);

    // Sync fills
    updateSliderFill(volumeSlider, volume, 0, 1);
    updateSliderFill(colorSlider, filterHz,
        parseFloat(colorSlider.min), parseFloat(colorSlider.max));

    // Sync color label
    colorReadout.textContent = getColorLabel(filterHz);

    // Sync active preset button
    if (preset) {
        document.querySelector(`.preset-btn[data-preset="${preset}"]`)
            ?.classList.add('active');
    }
})();

/* ═══════════════════════════════════════════════════════════
   1. PLAY / PAUSE
   ═══════════════════════════════════════════════════════════ */
async function togglePlayback() {
    try {
        const isPlaying = await audioEngine.toggle();

        iconPlay.style.display = isPlaying ? 'none' : 'block';
        iconPause.style.display = isPlaying ? 'block' : 'none';
        playBtn.setAttribute('aria-pressed', String(isPlaying));
        playBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');

        statusText.textContent = isPlaying ? 'Playing' : 'Paused';
        statusText.classList.toggle('active', isPlaying);
    } catch (err) {
        showError(err.message);
    }
}

playBtn.addEventListener('click', togglePlayback);

/* ═══════════════════════════════════════════════════════════
   2. KEYBOARD SHORTCUT — Space = play/pause
   ═══════════════════════════════════════════════════════════ */
document.addEventListener('keydown', (e) => {
    // Don't intercept if user is typing in an input element
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') {
        e.preventDefault(); // stop page scroll
        togglePlayback();
    }
});

/* ═══════════════════════════════════════════════════════════
   3. VOLUME SLIDER
   ═══════════════════════════════════════════════════════════ */
volumeSlider.addEventListener('input', () => {
    const val = parseFloat(volumeSlider.value);
    audioEngine.setVolume(val);
    updateSliderFill(volumeSlider, val, 0, 1);
    deactivatePresets();   // manual adjust — clear preset highlight
    persistState();
});

/* ═══════════════════════════════════════════════════════════
   4. COLOR (FILTER) SLIDER
   ═══════════════════════════════════════════════════════════ */
colorSlider.addEventListener('input', () => {
    const hz = parseFloat(colorSlider.value);
    const min = parseFloat(colorSlider.min);
    const max = parseFloat(colorSlider.max);

    audioEngine.setFilterFrequency(hz);
    updateSliderFill(colorSlider, hz, min, max);
    colorReadout.textContent = getColorLabel(hz);
    deactivatePresets();
    persistState();
});

/* ═══════════════════════════════════════════════════════════
   5. PRESETS
   ═══════════════════════════════════════════════════════════ */
function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;

    // Update engine
    audioEngine.setVolume(p.volume);
    audioEngine.setFilterFrequency(p.filterFreq);

    // Update sliders
    volumeSlider.value = String(p.volume);
    colorSlider.value = String(p.filterFreq);

    // Update fills
    updateSliderFill(volumeSlider, p.volume, 0, 1);
    updateSliderFill(
        colorSlider, p.filterFreq,
        parseFloat(colorSlider.min), parseFloat(colorSlider.max)
    );

    // Update color readout
    colorReadout.textContent = getColorLabel(p.filterFreq);

    // Highlight active preset button
    deactivatePresets();
    document.querySelector(`.preset-btn[data-preset="${name}"]`)
        ?.classList.add('active');

    persistState({ preset: name });
}

presetBtns.forEach(btn => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
});

function deactivatePresets() {
    presetBtns.forEach(b => b.classList.remove('active'));
}

/* ═══════════════════════════════════════════════════════════
   6. VISUALIZER — CANVAS SETUP
   ═══════════════════════════════════════════════════════════ */

/** Visualizer mode: 'bars' or 'wave' */
let vizMode = 'bars';

viewToggleBtn.addEventListener('click', () => {
    vizMode = vizMode === 'bars' ? 'wave' : 'bars';
    const isBars = vizMode === 'bars';

    vtBarsIcon.style.display = isBars ? 'block' : 'none';
    vtWaveIcon.style.display = isBars ? 'none' : 'block';
    viewToggleBtn.setAttribute('aria-pressed', String(!isBars));
    viewToggleBtn.setAttribute('aria-label',
        isBars ? 'Switch to waveform view' : 'Switch to bars view');
});

/**
 * Resize — uses setTransform() not scale(), so DPR adjustments
 * never accumulate across multiple resize events.
 */
function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    // setTransform REPLACES the current transform matrix — no stacking
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

/* ═══════════════════════════════════════════════════════════
   7. VISUALIZER — DRAW FUNCTIONS
   ═══════════════════════════════════════════════════════════ */

let idlePhase = 0;

/** Main render loop — called every animation frame */
function drawFrame() {
    const rect = canvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;

    ctx2d.clearRect(0, 0, W, H);

    const analyser = audioEngine.analyser;
    const playing = audioEngine.isPlaying;

    if (analyser && playing) {
        if (vizMode === 'bars') drawSpectrumBars(analyser, W, H);
        else drawWaveform(analyser, W, H);
    } else {
        if (vizMode === 'bars') drawIdlePulse(W, H);
        else drawIdleWave(W, H);
    }

    requestAnimationFrame(drawFrame);
}

/* ── Frequency bars (log-scaled) ── */
function drawSpectrumBars(analyser, W, H) {
    const bufferLen = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLen);
    analyser.getByteFrequencyData(dataArray);

    const barCount = 72;
    const gap = 3;
    const barW = (W - gap * (barCount - 1)) / barCount;
    const sampleRate = audioEngine.getSampleRate(); // ← no more _ctx leak
    const minFreq = 20;
    const nyquist = sampleRate / 2;

    for (let i = 0; i < barCount; i++) {
        // Logarithmic frequency mapping — gives bass room to breathe
        const t = i / barCount;
        const freq = minFreq * Math.pow(nyquist / minFreq, t);
        const binIndex = Math.min(
            Math.round((freq / nyquist) * bufferLen),
            bufferLen - 1
        );

        const amplitude = dataArray[binIndex] / 255;
        const barH = amplitude * H * 0.78;
        const x = i * (barW + gap);
        const y = H - barH;

        const hue = 28 + (1 - amplitude) * 14;
        const lightness = 38 + amplitude * 36;
        const alpha = 0.5 + amplitude * 0.5;

        // Main bar
        ctx2d.fillStyle = `hsla(${hue}, 72%, ${lightness}%, ${alpha})`;
        ctx2d.beginPath();
        if (ctx2d.roundRect) {
            ctx2d.roundRect(x, y, barW, barH, [2, 2, 0, 0]);
        } else {
            ctx2d.rect(x, y, barW, barH);
        }
        ctx2d.fill();

        // Reflection
        const reflH = barH * 0.3;
        const grad = ctx2d.createLinearGradient(0, H, 0, H + reflH);
        grad.addColorStop(0, `hsla(${hue}, 72%, ${lightness}%, ${alpha * 0.3})`);
        grad.addColorStop(1, 'transparent');
        ctx2d.fillStyle = grad;
        ctx2d.beginPath();
        if (ctx2d.roundRect) {
            ctx2d.roundRect(x, H, barW, reflH, [0, 0, 2, 2]);
        } else {
            ctx2d.rect(x, H, barW, reflH);
        }
        ctx2d.fill();
    }
}

/* ── Waveform (oscilloscope) ── */
function drawWaveform(analyser, W, H) {
    const bufLen = analyser.fftSize;
    const data = new Uint8Array(bufLen);
    analyser.getByteTimeDomainData(data);

    const sliceW = W / bufLen;

    // Pass 1 — wide glow
    ctx2d.beginPath();
    ctx2d.strokeStyle = 'rgba(200,130,74,0.18)';
    ctx2d.lineWidth = 7;
    ctx2d.lineJoin = 'round';
    ctx2d.lineCap = 'round';
    let x = 0;
    for (let i = 0; i < bufLen; i++) {
        const v = data[i] / 128.0;
        const y = (v * H) / 2;
        i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
        x += sliceW;
    }
    ctx2d.stroke();

    // Pass 2 — crisp foreground line
    ctx2d.beginPath();
    ctx2d.strokeStyle = 'rgba(224,154,96,0.92)';
    ctx2d.lineWidth = 2;
    x = 0;
    for (let i = 0; i < bufLen; i++) {
        const v = data[i] / 128.0;
        const y = (v * H) / 2;
        i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
        x += sliceW;
    }
    ctx2d.stroke();
}

/* ── Idle: radial breathing pulse (bars mode, not playing) ── */
function drawIdlePulse(W, H) {
    idlePhase += 0.007;
    const cx = W / 2;
    const cy = H / 2;
    const base = Math.min(W, H) * 0.11;
    const r = base + Math.sin(idlePhase) * base * 0.2;

    const grad = ctx2d.createRadialGradient(cx, cy, 0, cx, cy, r * 3.5);
    grad.addColorStop(0, 'rgba(200,130,74,0.10)');
    grad.addColorStop(0.5, 'rgba(200,130,74,0.03)');
    grad.addColorStop(1, 'transparent');

    ctx2d.fillStyle = grad;
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, r * 3.5, 0, Math.PI * 2);
    ctx2d.fill();

    const alpha = 0.10 + Math.sin(idlePhase) * 0.06;
    ctx2d.strokeStyle = `rgba(200,130,74,${alpha})`;
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, r, 0, Math.PI * 2);
    ctx2d.stroke();
}

/* ── Idle: gentle low-amplitude sine (wave mode, not playing) ── */
function drawIdleWave(W, H) {
    idlePhase += 0.012;
    const cy = H / 2;
    const amp = H * 0.045;

    ctx2d.beginPath();
    ctx2d.strokeStyle = 'rgba(200,130,74,0.20)';
    ctx2d.lineWidth = 2;
    ctx2d.lineJoin = 'round';

    for (let px = 0; px <= W; px += 2) {
        const t = px / W;
        const y = cy + Math.sin(t * Math.PI * 6 + idlePhase) * amp;
        px === 0 ? ctx2d.moveTo(px, y) : ctx2d.lineTo(px, y);
    }
    ctx2d.stroke();
}

/* ── Kick off the render loop ── */
requestAnimationFrame(drawFrame);
