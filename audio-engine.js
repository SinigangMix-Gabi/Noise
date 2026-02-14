/**
 * audio-engine.js
 * ─────────────────────────────────────────────────────────
 * Brown Noise Focus Station — Audio Engine
 *
 * FIXES vs v1:
 *   • Removed `_ctx` public access — use getSampleRate() instead
 *   • Linear gain (removed val² curve — visual/audio match now
 *     handled honestly; see setVolume notes)
 *   • Fade in / fade out on toggle (1.5s ramp, non-blocking)
 *   • Proper error handling on AudioContext creation
 *   • getState() / setState() for localStorage persistence
 * ─────────────────────────────────────────────────────────
 */

/* ── Inline AudioWorklet code (injected via Blob URL) ────── */
const WORKLET_CODE = /* js */`
class BrownNoiseProcessor extends AudioWorkletProcessor {
  constructor () {
    super();
    this._lastOut = 0.0;
  }

  process (_inputs, outputs) {
    const channel = outputs[0][0];
    for (let i = 0; i < channel.length; i++) {
      const white   = Math.random() * 2 - 1;
      this._lastOut = (this._lastOut + (0.02 * white)) / 1.02;
      channel[i]    = this._lastOut * 3.5;
    }
    return true;
  }
}
registerProcessor('brown-noise-processor', BrownNoiseProcessor);
`;

/* ── Default state ─────────────────────────────────────── */
const DEFAULTS = {
    volume: 0.6,
    filterFreq: 400,
};

export class AudioEngine {
    constructor() {
        this._ctx = null;
        this._sourceNode = null;
        this._lpFilter = null;
        this._gainNode = null;
        this._analyser = null;

        this._isPlaying = false;
        this._volume = DEFAULTS.volume;
        this._filterFreq = DEFAULTS.filterFreq;

        /** Public reference to the AnalyserNode for the visualizer */
        this.analyser = null;
    }

    /* ═══════════════════════════════════════════════════════
       PUBLIC API
       ═══════════════════════════════════════════════════════ */

    /**
     * One-time setup. Must be called from a user-gesture handler
     * to satisfy browser autoplay policy.
     *
     * @throws {Error} if AudioContext is not supported / blocked
     */
    async init() {
        if (this._ctx) return; // already initialised — no-op

        // ── Create AudioContext (with explicit error handling) ──
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) {
            throw new Error(
                'Web Audio API is not supported in this browser. ' +
                'Please use a modern browser such as Chrome, Firefox, or Safari.'
            );
        }

        try {
            this._ctx = new AudioCtx();
        } catch (err) {
            throw new Error(`AudioContext creation failed: ${err.message}`);
        }

        // ── Build audio graph ──
        // source → LPF → gainNode → analyser → destination

        this._lpFilter = this._ctx.createBiquadFilter();
        this._lpFilter.type = 'lowpass';
        this._lpFilter.frequency.value = this._filterFreq;
        this._lpFilter.Q.value = 0.5;

        this._gainNode = this._ctx.createGain();
        // Start at silence; _fadeIn() will ramp up on first play
        this._gainNode.gain.value = 0.0001;

        this._analyser = this._ctx.createAnalyser();
        this._analyser.fftSize = 2048;
        this._analyser.smoothingTimeConstant = 0.82;
        this.analyser = this._analyser;

        this._lpFilter.connect(this._gainNode);
        this._gainNode.connect(this._analyser);
        this._analyser.connect(this._ctx.destination);

        // ── Create noise source (Worklet preferred, SP fallback) ──
        const supportsWorklet = (
            typeof AudioWorkletNode !== 'undefined' &&
            !!this._ctx.audioWorklet
        );

        if (supportsWorklet) {
            await this._initWorklet();
        } else {
            this._initScriptProcessor();
        }

        // Context starts suspended → satisfies autoplay policy
        await this._ctx.suspend();
    }

    /**
     * Toggle playback.
     * Returns the new playing state immediately; fading is async.
     * @returns {Promise<boolean>}
     */
    async toggle() {
        if (!this._ctx) await this.init();

        if (this._isPlaying) {
            this._isPlaying = false;
            this._fadeOut();                // non-blocking, suspends after ramp
        } else {
            await this._ctx.resume();
            this._fadeIn();                 // non-blocking ramp up
            this._isPlaying = true;
        }

        return this._isPlaying;
    }

    /**
     * Set output volume.
     * Linear scale 0–1. Visual fill in app.js should also be linear
     * so the slider position honestly represents perceived loudness.
     * @param {number} value  0.0 – 1.0
     */
    setVolume(value) {
        this._volume = Math.max(0, Math.min(1, value));
        if (this._gainNode && this._isPlaying) {
            this._gainNode.gain.setTargetAtTime(
                this._volume,
                this._ctx.currentTime,
                0.06
            );
        }
    }

    /**
     * Set the low-pass filter cutoff frequency.
     *   100–400 Hz  → deep brown / sub-heavy
     *   400–900 Hz  → warm brown (default zone)
     *   900–1600 Hz → amber / balanced
     *   1600–3500Hz → softer / near-white
     *
     * @param {number} hz  Cutoff in Hertz
     */
    setFilterFrequency(hz) {
        this._filterFreq = hz;
        if (this._lpFilter) {
            this._lpFilter.frequency.setTargetAtTime(
                hz,
                this._ctx.currentTime,
                0.08  // ~80 ms smooth ramp — prevents zipper noise
            );
        }
    }

    /**
     * Snapshot current settings for localStorage.
     * @returns {{ volume: number, filterFreq: number }}
     */
    getState() {
        return {
            volume: this._volume,
            filterFreq: this._filterFreq,
        };
    }

    /**
     * Apply a saved state snapshot (without triggering play).
     * @param {{ volume?: number, filterFreq?: number }} state
     */
    setState(state) {
        if (typeof state.volume === 'number') this._volume = state.volume;
        if (typeof state.filterFreq === 'number') this._filterFreq = state.filterFreq;

        // If graph already exists (unlikely on cold load, but safe)
        if (this._gainNode) this._gainNode.gain.value = 0.0001;
        if (this._lpFilter) this._lpFilter.frequency.value = this._filterFreq;
    }

    /**
     * Returns the sample rate of the AudioContext,
     * or a sensible default if the context hasn't been created yet.
     * Replaces the old `audioEngine._ctx.sampleRate` leak.
     * @returns {number}
     */
    getSampleRate() {
        return this._ctx ? this._ctx.sampleRate : 44100;
    }

    /** @returns {boolean} */
    get isPlaying() { return this._isPlaying; }

    /* ═══════════════════════════════════════════════════════
       PRIVATE — FADE HELPERS
       ═══════════════════════════════════════════════════════ */

    _fadeIn() {
        const t = this._ctx.currentTime;
        this._gainNode.gain.cancelScheduledValues(t);
        this._gainNode.gain.setValueAtTime(0.0001, t);
        // setTargetAtTime(target, startTime, timeConstant)
        // timeConstant 0.45 ≈ 63% of target after 0.45s, ~99% after ~2s
        this._gainNode.gain.setTargetAtTime(this._volume, t, 0.45);
    }

    _fadeOut() {
        const t = this._ctx.currentTime;
        this._gainNode.gain.cancelScheduledValues(t);
        // Ramp toward near-zero; never exactly 0 to avoid AudioParam log issues
        this._gainNode.gain.setTargetAtTime(0.0001, t, 0.38);

        // After the fade has settled, actually suspend the context
        // Check _isPlaying guard to handle rapid double-clicks gracefully
        setTimeout(async () => {
            if (!this._isPlaying && this._ctx?.state === 'running') {
                try { await this._ctx.suspend(); } catch (_) { /* ignore */ }
            }
        }, 2200);
    }

    /* ═══════════════════════════════════════════════════════
       PRIVATE — SOURCE NODE CREATION
       ═══════════════════════════════════════════════════════ */

    async _initWorklet() {
        const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
        const blobURL = URL.createObjectURL(blob);

        try {
            await this._ctx.audioWorklet.addModule(blobURL);
            this._sourceNode = new AudioWorkletNode(this._ctx, 'brown-noise-processor');
            this._sourceNode.connect(this._lpFilter);
        } finally {
            URL.revokeObjectURL(blobURL); // clean up memory immediately
        }
    }

    /** ScriptProcessorNode fallback for browsers without AudioWorklet */
    _initScriptProcessor() {
        const proc = this._ctx.createScriptProcessor(4096, 1, 1);
        let lastOut = 0;

        proc.onaudioprocess = (e) => {
            const out = e.outputBuffer.getChannelData(0);
            for (let i = 0; i < out.length; i++) {
                const white = Math.random() * 2 - 1;
                lastOut = (lastOut + (0.02 * white)) / 1.02;
                out[i] = lastOut * 3.5;
            }
        };

        proc.connect(this._lpFilter);
        this._sourceNode = proc;
    }
}

/** Shared singleton — import this in app.js */
export const audioEngine = new AudioEngine();
