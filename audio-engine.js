/**
 * audio-engine.js
 * ─────────────────────────────────────────────────────────
 * Brown Noise Focus Station — Audio Engine
 *
 * Responsibilities:
 *   • Generate true brown (red) noise via an integrated
 *     white-noise source (AudioWorkletNode or ScriptProcessor
 *     fallback).
 *   • Expose a simple public API consumed by app.js.
 *   • Provide a live AnalyserNode for the canvas visualizer.
 *
 * Brown noise math:
 *   Each sample = previousSample + (whiteSample * 0.02)
 *   clamped to [-1, 1] and normalised to prevent DC drift.
 * ─────────────────────────────────────────────────────────
 */

/* ── Inline Worklet Processor code (injected as a Blob URL) ── */
const WORKLET_CODE = /* js */`
class BrownNoiseProcessor extends AudioWorkletProcessor {
  constructor () {
    super();
    this._lastOut = 0.0;
  }

  process (_inputs, outputs) {
    const output = outputs[0];
    const channel = output[0];

    for (let i = 0; i < channel.length; i++) {
      // White noise sample in [-1, 1]
      const white = Math.random() * 2 - 1;

      // Brown / Brownian integration
      this._lastOut = (this._lastOut + (0.02 * white)) / 1.02;

      // Amplify and write (×3.5 restores perceived loudness)
      channel[i] = this._lastOut * 3.5;
    }
    return true; // keep processor alive
  }
}

registerProcessor('brown-noise-processor', BrownNoiseProcessor);
`;

/**
 * AudioEngine — singleton-safe class.
 * Consumers should call `await engine.init()` once, then
 * use the rest of the API freely.
 */
export class AudioEngine {
    constructor() {
        /** @type {AudioContext|null} */
        this._ctx = null;
        /** @type {AudioWorkletNode|ScriptProcessorNode|null} */
        this._sourceNode = null;
        /** @type {BiquadFilterNode|null} */
        this._lpFilter = null;
        /** @type {GainNode|null} */
        this._gainNode = null;
        /** @type {AnalyserNode|null} */
        this._analyser = null;

        this._isPlaying = false;
        this._volume = 0.6;
        this._filterFreq = 400;

        /** Expose analyser for the visualizer */
        this.analyser = null;
    }

    /* ─────────────────────────────────────────────────────
       Public API
       ───────────────────────────────────────────────────── */

    /**
     * One-time initialisation. Must be called from a user
     * gesture handler to satisfy browser autoplay policy.
     */
    async init() {
        if (this._ctx) return; // already initialised

        this._ctx = new (window.AudioContext || window.webkitAudioContext)();

        // ── Graph: source → LPF → gain → analyser → destination ──
        this._lpFilter = this._ctx.createBiquadFilter();
        this._lpFilter.type = 'lowpass';
        this._lpFilter.frequency.value = this._filterFreq;
        this._lpFilter.Q.value = 0.5;

        this._gainNode = this._ctx.createGain();
        this._gainNode.gain.value = this._volume;

        this._analyser = this._ctx.createAnalyser();
        this._analyser.fftSize = 2048;
        this._analyser.smoothingTimeConstant = 0.82;
        this.analyser = this._analyser;

        this._lpFilter.connect(this._gainNode);
        this._gainNode.connect(this._analyser);
        this._analyser.connect(this._ctx.destination);

        // Attempt to use AudioWorklet (modern); fall back to
        // the deprecated ScriptProcessorNode if unavailable.
        const useWorklet = (
            typeof AudioWorkletNode !== 'undefined' &&
            this._ctx.audioWorklet
        );

        if (useWorklet) {
            await this._initWorklet();
        } else {
            this._initScriptProcessor();
        }
    }

    /** Toggle playback. Returns the new playing state. */
    async toggle() {
        if (!this._ctx) await this.init();

        if (this._isPlaying) {
            await this._ctx.suspend();
            this._isPlaying = false;
        } else {
            await this._ctx.resume();
            this._isPlaying = true;
        }
        return this._isPlaying;
    }

    /** @param {number} value 0–1 */
    setVolume(value) {
        this._volume = Math.max(0, Math.min(1, value));
        if (this._gainNode) {
            // Exponential curve → more natural perceived loudness
            const exp = this._volume * this._volume;
            this._gainNode.gain.setTargetAtTime(exp, this._ctx.currentTime, 0.05);
        }
    }

    /**
     * Adjust the low-pass filter cutoff frequency.
     * Low values (~100–400 Hz) → deep brown.
     * High values (~2000–3500 Hz) → lighter / whiter.
     * @param {number} hz  Frequency in Hertz
     */
    setFilterFrequency(hz) {
        this._filterFreq = hz;
        if (this._lpFilter) {
            this._lpFilter.frequency.setTargetAtTime(
                hz,
                this._ctx.currentTime,
                0.08   // smooth ~80 ms ramp
            );
        }
    }

    get isPlaying() { return this._isPlaying; }

    /* ─────────────────────────────────────────────────────
       Private helpers
       ───────────────────────────────────────────────────── */

    async _initWorklet() {
        // Blob URL trick lets us inline the worklet without a
        // separate file while still satisfying the "separate
        // module script" requirement of AudioWorklet.
        const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
        const blobURL = URL.createObjectURL(blob);

        try {
            await this._ctx.audioWorklet.addModule(blobURL);
            this._sourceNode = new AudioWorkletNode(this._ctx, 'brown-noise-processor');
            this._sourceNode.connect(this._lpFilter);

            // Context starts suspended → honours autoplay policy
            await this._ctx.suspend();
        } finally {
            URL.revokeObjectURL(blobURL);
        }
    }

    _initScriptProcessor() {
        const bufferSize = 4096;
        // eslint-disable-next-line no-undef
        const processor = this._ctx.createScriptProcessor(bufferSize, 1, 1);
        let lastOut = 0;

        processor.onaudioprocess = (e) => {
            const output = e.outputBuffer.getChannelData(0);
            for (let i = 0; i < output.length; i++) {
                const white = Math.random() * 2 - 1;
                lastOut = (lastOut + (0.02 * white)) / 1.02;
                output[i] = lastOut * 3.5;
            }
        };

        processor.connect(this._lpFilter);
        this._sourceNode = processor;
        this._ctx.suspend();
    }
}

/* Export a shared singleton */
export const audioEngine = new AudioEngine();