// Procedural Web Audio engine for Gravity Orbit.
// Everything is synthesized -- no audio files, zero network cost.

class GameAudio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private musicGain: GainNode | null = null
  private sfxGain: GainNode | null = null
  private musicTimer: number | null = null
  private nextNoteTime = 0
  private stepIndex = 0
  private _muted = false

  get muted() {
    return this._muted
  }

  /** Must be called from a user gesture (pointerdown). Safe to call repeatedly. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume()
      return
    }
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.ctx = new Ctor()
    } catch {
      return
    }
    this.master = this.ctx.createGain()
    this.master.gain.value = this._muted ? 0 : 1
    this.master.connect(this.ctx.destination)

    this.musicGain = this.ctx.createGain()
    this.musicGain.gain.value = 0.16
    this.musicGain.connect(this.master)

    this.sfxGain = this.ctx.createGain()
    this.sfxGain.gain.value = 0.5
    this.sfxGain.connect(this.master)
  }

  setMuted(muted: boolean) {
    this._muted = muted
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.02)
    }
  }

  // ---- SFX --------------------------------------------------------------

  /** Quick rising zip when the player launches off an orbit. */
  playLaunch() {
    const ctx = this.ctx
    if (!ctx || !this.sfxGain) return
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(220, t)
    osc.frequency.exponentialRampToValueAtTime(880, t + 0.12)
    gain.gain.setValueAtTime(0.22, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16)
    osc.connect(gain)
    gain.connect(this.sfxGain)
    osc.start(t)
    osc.stop(t + 0.18)
  }

  /** Soft bright ping when landing on a node. Pitch rises a bit with score. */
  playLand(score: number) {
    const ctx = this.ctx
    if (!ctx || !this.sfxGain) return
    const t = ctx.currentTime
    const base = 523.25 * Math.pow(2, Math.min(score % 8, 7) / 12) // walks up a scale
    for (const [freq, delay, vol] of [
      [base, 0, 0.2],
      [base * 1.5, 0.03, 0.1],
    ] as const) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, t + delay)
      gain.gain.linearRampToValueAtTime(vol, t + delay + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.3)
      osc.connect(gain)
      gain.connect(this.sfxGain)
      osc.start(t + delay)
      osc.stop(t + delay + 0.32)
    }
  }

  /** Short downward whoosh when the player flips their orbit direction. */
  playReverse() {
    const ctx = this.ctx
    if (!ctx || !this.sfxGain) return
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.setValueAtTime(1200, t)
    filter.frequency.exponentialRampToValueAtTime(400, t + 0.18)
    filter.Q.value = 2
    osc.type = 'square'
    osc.frequency.setValueAtTime(660, t)
    osc.frequency.exponentialRampToValueAtTime(300, t + 0.16)
    gain.gain.setValueAtTime(0.16, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2)
    osc.connect(filter)
    filter.connect(gain)
    gain.connect(this.sfxGain)
    osc.start(t)
    osc.stop(t + 0.22)
  }

  /** Crunchy descending noise burst on death. */
  playDeath() {
    const ctx = this.ctx
    if (!ctx || !this.sfxGain) return
    const t = ctx.currentTime
    // noise burst
    const len = Math.floor(ctx.sampleRate * 0.35)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / len)
    }
    const noise = ctx.createBufferSource()
    noise.buffer = buf
    const nGain = ctx.createGain()
    nGain.gain.setValueAtTime(0.32, t)
    nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.35)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(2400, t)
    filter.frequency.exponentialRampToValueAtTime(160, t + 0.35)
    noise.connect(filter)
    filter.connect(nGain)
    nGain.connect(this.sfxGain)
    noise.start(t)
    // falling tone underneath
    const osc = ctx.createOscillator()
    const oGain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(340, t)
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.4)
    oGain.gain.setValueAtTime(0.25, t)
    oGain.gain.exponentialRampToValueAtTime(0.001, t + 0.42)
    osc.connect(oGain)
    oGain.connect(this.sfxGain)
    osc.start(t)
    osc.stop(t + 0.45)
  }

  // ---- Music ---------------------------------------------------------------
  // A slow ambient arpeggio in A minor pentatonic over a low drone,
  // scheduled with a lookahead timer so it never glitches.

  startMusic() {
    const ctx = this.ctx
    if (!ctx || this.musicTimer !== null) return
    this.nextNoteTime = ctx.currentTime + 0.1
    this.stepIndex = 0
    const stepDur = 60 / 112 / 2 // 112 BPM eighth notes
    // A2 drone + A minor pentatonic arpeggio pattern (Hz)
    const pattern = [220, 261.63, 329.63, 392, 440, 392, 329.63, 261.63, 220, 329.63, 293.66, 392, 440, 523.25, 392, 293.66]

    const scheduleNote = (freq: number, time: number, accent: boolean) => {
      if (!this.musicGain) return
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, time)
      gain.gain.linearRampToValueAtTime(accent ? 0.5 : 0.3, time + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, time + stepDur * 1.8)
      osc.connect(gain)
      gain.connect(this.musicGain)
      osc.start(time)
      osc.stop(time + stepDur * 2)
      // faint echo an octave up
      if (accent) {
        const osc2 = ctx.createOscillator()
        const gain2 = ctx.createGain()
        osc2.type = 'sine'
        osc2.frequency.value = freq * 2
        gain2.gain.setValueAtTime(0, time + stepDur)
        gain2.gain.linearRampToValueAtTime(0.12, time + stepDur + 0.02)
        gain2.gain.exponentialRampToValueAtTime(0.001, time + stepDur * 2.5)
        osc2.connect(gain2)
        gain2.connect(this.musicGain)
        osc2.start(time + stepDur)
        osc2.stop(time + stepDur * 2.6)
      }
    }

    const scheduleDrone = (time: number, dur: number) => {
      if (!this.musicGain) return
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = 110 // A2
      gain.gain.setValueAtTime(0, time)
      gain.gain.linearRampToValueAtTime(0.35, time + dur * 0.2)
      gain.gain.linearRampToValueAtTime(0.001, time + dur)
      osc.connect(gain)
      gain.connect(this.musicGain)
      osc.start(time)
      osc.stop(time + dur)
    }

    this.musicTimer = window.setInterval(() => {
      if (!this.ctx) return
      while (this.nextNoteTime < this.ctx.currentTime + 0.25) {
        const step = this.stepIndex % pattern.length
        scheduleNote(pattern[step], this.nextNoteTime, step % 4 === 0)
        if (step === 0) scheduleDrone(this.nextNoteTime, stepDur * pattern.length)
        this.nextNoteTime += stepDur
        this.stepIndex++
      }
    }, 100)
  }

  stopMusic() {
    if (this.musicTimer !== null) {
      window.clearInterval(this.musicTimer)
      this.musicTimer = null
    }
  }
}

export const gameAudio = new GameAudio()
