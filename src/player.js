import { Emitter } from './emitter.js';

/**
 * SongPlayer — loads a song (URL or File) into an AudioBuffer and plays it
 * through the WebAudio graph. Exposes an output GainNode that the Analyzer
 * taps before the signal reaches the speakers.
 *
 * Events: 'load' {duration}, 'play', 'pause', 'ended', 'seek' {time}
 */
export class SongPlayer extends Emitter {
  constructor(audioContext) {
    super();
    this.ctx = audioContext ?? new (window.AudioContext || window.webkitAudioContext)();
    this.output = this.ctx.createGain();
    this.output.connect(this.ctx.destination);

    this.buffer = null;
    this.source = null;      // current AudioBufferSourceNode (one-shot, recreated per play)
    this.startedAt = 0;      // ctx.currentTime when playback started
    this.offset = 0;         // song position when playback started/paused
    this.playing = false;
    this.playToken = 0;      // invalidates play() calls parked on ctx.resume()
  }

  /** Accepts a URL string or a File/Blob (e.g. from an <input type="file">). */
  async load(song) {
    this.stop();
    const arrayBuffer = song instanceof Blob
      ? await song.arrayBuffer()
      : await (await fetch(song)).arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.offset = 0;
    this.emit('load', { duration: this.buffer.duration });
  }

  get duration() {
    return this.buffer?.duration ?? 0;
  }

  /** Current playback position in seconds. */
  get currentTime() {
    if (!this.playing) return this.offset;
    return Math.min(this.offset + (this.ctx.currentTime - this.startedAt), this.duration);
  }

  async play() {
    if (!this.buffer || this.playing) return;
    // Claim playback *before* the possible await: a second play() arriving
    // while ctx.resume() is pending must not start a duplicate source.
    this.playing = true;
    this.startedAt = this.ctx.currentTime;
    const token = ++this.playToken;
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
      // Stopped, or superseded by another play() (e.g. via seek), while parked.
      if (!this.playing || this.playToken !== token) return;
    }

    const source = this.ctx.createBufferSource();
    this.source = source;
    source.buffer = this.buffer;
    source.connect(this.output);
    source.onended = () => {
      // Fires for both natural end and manual stop, and can arrive late from
      // a source that stop()/seek()/load() already replaced — only treat as
      // 'ended' if this source is still current and we ran off the end.
      if (this.source !== source) return;
      if (this.playing && this.currentTime >= this.duration - 0.05) {
        this.playing = false;
        this.offset = 0;
        this.emit('ended');
      }
    };
    source.start(0, this.offset);
    this.startedAt = this.ctx.currentTime;
    this.emit('play');
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.currentTime;
    this.stop();
    this.emit('pause');
  }

  seek(time) {
    const wasPlaying = this.playing;
    this.offset = Math.max(0, Math.min(time, this.duration));
    if (wasPlaying) {
      this.stop();
      this.play();
    }
    this.emit('seek', { time: this.offset });
  }

  /** Tear down the current source node without emitting events. */
  stop() {
    // Cleared even with no source yet, so a play() parked on ctx.resume()
    // sees the stop and bails instead of starting a source afterwards.
    this.playing = false;
    if (this.source) {
      try { this.source.stop(); } catch { /* already stopped */ }
      this.source.disconnect();
      this.source = null;
    }
  }
}
