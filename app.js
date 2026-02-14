/**
 * app.js
 * ─────────────────────────────────────────────────────────
 * Brown Noise Focus Station — UI Controller
 *
 * Responsibilities:
 *   • Bind DOM events to the AudioEngine API.
 *   • Drive the canvas visualizer animation loop.
 *   • Keep the slider fill tracks visually updated.
 * ─────────────────────────────────────────────────────────
 */

import { audioEngine } from './audio-engine.js';

/* ── DOM references ── */
const playBtn = document.getElementById('play-btn');
const iconPlay = document.getElementById('icon-play');
const iconPause = document.getElementById('icon-pause');
const statusText = document.getElementById('status-text');
const volumeSlider = document.getElementById('volume-slider');
const colorSlider = document.getElementById('color-slider');
const canvas = document.getElementById('visualizer-canvas');
const ctx2d = canvas.getContext('2d');

/* ═══════════════════════════════════════════════════════════
   1. PLAY / PAUSE
   ═══════════════════════════════════════════════════════════ */
playBtn.addEventListener('click', async () => {
    const isPlaying = await audioEngine.toggle();

    // Swap icons
    iconPlay.style.display = isPlaying ? 'none' : 'block';
    iconPause.style.display = isPlaying ? 'block' : 'none';

    // ARIA
    playBtn.setAttribute('aria-pressed', String(isPlaying));
    playBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');

    // Status label
    statusText.textContent = isPlaying ? 'Playing' : 'Paused';
    statusText.classList.toggle('active', isPlaying);
});

/* ═══════════════════════════════════════════════════════════
   2. VOLUME SLIDER
   ═══════════════════════════════════════════════════════════ */
volumeSlider.addEventListener('input', () => {
    const val = parseFloat(volumeSlider.value);
    audioEngine.setVolume(val);
    updateSliderFill(volumeSlider, val, 0, 1);
});

// Set initial fill on load
updateSliderFill(volumeSlider, parseFloat(volumeSlider.value), 0, 1);

/* ═══════════════════════════════════════════════════════════
   3. COLOR (FILTER) SLIDER
   ═══════════════════════════════════════════════════════════ */
colorSlider.addEventListener('input', () => {
    const hz = parseFloat(colorSlider.value);
    const min = parseFloat(colorSlider.min);
    const max = parseFloat(colorSlider.max);
    audioEngine.setFilterFrequency(hz);
    updateSliderFill(colorSlider, hz, min, max);
});

// Set initial fill on load
updateSliderFill(
    colorSlider,
    parseFloat(colorSlider.value),
    parseFloat(colorSlider.min),
    parseFloat(colorSlider.max)
);

/* ═══════════════════════════════════════════════════════════
   4. CANVAS VISUALIZER
   ═══════════════════════════════════════════════════════════ */

/** Resize canvas to match its CSS display size (DPI-aware). */
function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx2d.scale(dpr, dpr);          // normalise so we draw in CSS px
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

/**
 * Draw a single frame of the frequency-bar visualizer.
 * Falls back to a gentle idle animation when audio hasn't
 * been initialised yet (no AnalyserNode).
 */
let idlePhase = 0;

function drawFrame() {
    const W = canvas.getBoundingClientRect().width;
    const H = canvas.getBoundingClientRect().height;

    ctx2d.clearRect(0, 0, W, H);

    const analyser = audioEngine.analyser;

    if (analyser) {
        drawSpectrumBars(analyser, W, H);
    } else {
        drawIdlePulse(W, H);
    }

    requestAnimationFrame(drawFrame);
}

/**
 * Frequency-bar spectrum display.
 * Uses a logarithmic-ish bin grouping so bass frequencies
 * aren't squashed on the left.
 */
function drawSpectrumBars(analyser, W, H) {
    const bufferLen = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLen);
    analyser.getByteFrequencyData(dataArray);

    const barCount = 80;
    const gap = 3;
    const barW = (W - gap * (barCount - 1)) / barCount;

    // Logarithmic bin mapping
    const nyquist = 20000;
    const minFreq = 20;

    for (let i = 0; i < barCount; i++) {
        // Map bar index → frequency (log scale)
        const t = i / barCount;
        const freq = minFreq * Math.pow(nyquist / minFreq, t);
        // Map frequency → FFT bin index
        const sampleRate = audioEngine._ctx
            ? audioEngine._ctx.sampleRate
            : 44100;
        const binIndex = Math.round((freq / (sampleRate / 2)) * bufferLen);
        const clampedBin = Math.min(binIndex, bufferLen - 1);

        const amplitude = dataArray[clampedBin] / 255; // 0–1
        const barH = amplitude * H * 0.75;
        const x = i * (barW + gap);
        const y = H - barH;

        // Colour: warm amber at bottom, cooler orange-red near top
        const lightness = 40 + amplitude * 35;
        const hue = 28 + (1 - amplitude) * 15; // 28–43° range
        const alpha = 0.55 + amplitude * 0.45;

        ctx2d.fillStyle = `hsla(${hue}, 72%, ${lightness}%, ${alpha})`;
        ctx2d.beginPath();
        ctx2d.roundRect
            ? ctx2d.roundRect(x, y, barW, barH, [2, 2, 0, 0])
            : ctx2d.rect(x, y, barW, barH);
        ctx2d.fill();

        // Subtle reflection below
        const gradR = ctx2d.createLinearGradient(0, H, 0, H + barH * 0.35);
        gradR.addColorStop(0, `hsla(${hue}, 72%, ${lightness}%, ${alpha * 0.35})`);
        gradR.addColorStop(1, 'transparent');
        ctx2d.fillStyle = gradR;
        ctx2d.beginPath();
        ctx2d.roundRect
            ? ctx2d.roundRect(x, H, barW, barH * 0.35, [0, 0, 2, 2])
            : ctx2d.rect(x, H, barW, barH * 0.35);
        ctx2d.fill();
    }
}

/** Gentle breathing ring animation shown before first play. */
function drawIdlePulse(W, H) {
    idlePhase += 0.008;
    const cx = W / 2;
    const cy = H / 2;
    const base = Math.min(W, H) * 0.12;
    const pulse = base + Math.sin(idlePhase) * base * 0.18;

    const grad = ctx2d.createRadialGradient(cx, cy, 0, cx, cy, pulse * 3);
    grad.addColorStop(0, 'rgba(200, 130, 74, 0.12)');
    grad.addColorStop(0.5, 'rgba(200, 130, 74, 0.04)');
    grad.addColorStop(1, 'transparent');

    ctx2d.fillStyle = grad;
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, pulse * 3, 0, Math.PI * 2);
    ctx2d.fill();

    ctx2d.strokeStyle = `rgba(200, 130, 74, ${0.12 + Math.sin(idlePhase) * 0.08})`;
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, pulse, 0, Math.PI * 2);
    ctx2d.stroke();
}

// Kick off the render loop immediately
requestAnimationFrame(drawFrame);

/* ═══════════════════════════════════════════════════════════
   5. HELPERS
   ═══════════════════════════════════════════════════════════ */

/**
 * Updates the CSS custom property `--fill` on a range input
 * so the custom track fill always matches the thumb position.
 *
 * @param {HTMLInputElement} slider
 * @param {number}           value   Current value
 * @param {number}           min     Slider min
 * @param {number}           max     Slider max
 */
function updateSliderFill(slider, value, min, max) {
    const pct = ((value - min) / (max - min)) * 100;
    slider.style.setProperty('--fill', `${pct.toFixed(1)}%`);
}