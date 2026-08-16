import { Emitter } from './emitter.js';

const isMediaElement = (v) =>
  typeof HTMLMediaElement !== 'undefined' && v instanceof HTMLMediaElement;

const isAudioNode = (v) => typeof AudioNode !== 'undefined' && v instanceof AudioNode;

// createMediaElementSource() throws if called twice for the same element, so
// the node is cached and reused across reloads of that element.
const elementSources = new WeakMap();

const whenMetadata = (el) => new Promise((resolve, reject) => {
  if (el.readyState >= 1 /* HAVE_METADATA */) return resolve();
  el.addEventListener('loadedmetadata', () => resolve(), { once: true });
  el.addEventListener('error', () => {
    reject(new Error(`SongPlayer: media element failed to load (${el.currentSrc || el.src})`));
  }, { once: true });
});

/**
 * BufferSource — decoded into memory, so we own the transport completely:
 * position is derived from the AudioContext clock, and seeking means throwing
 * the node away and starting a new one at an offset.
 */
class BufferSource {
  constructor(player, buffer) {
    this.player = player;
    this.buffer = buffer;
    this.node = null;
    this.startedAt = 0;   // ctx.currentTime when playback started
    this.offset = 0;      // song position when playback started/paused
    this.active = false;
  }

  get duration() { return this.buffer.duration; }
  get playing() { return this.active; }

  get currentTime() {
    if (!this.active) return this.offset;
    return Math.min(this.offset + (this.player.ctx.currentTime - this.startedAt), this.duration);
  }

  play() {
    if (this.active) return;
    const { ctx, output } = this.player;
    this.node = ctx.createBufferSource();
    this.node.buffer = this.buffer;
    this.node.connect(output);
    this.node.onended = () => {
      // Fires for both natural end and manual stop; only treat as 'ended'
      // if we ran off the end of the buffer.
      if (this.active && this.currentTime >= this.duration - 0.05) {
        this.active = false;
        this.offset = 0;
        this.player.emit('ended');
      }
    };
    this.node.start(0, this.offset);
    this.startedAt = ctx.currentTime;
    this.active = true;
    this.player.emit('play');
  }

  pause() {
    if (!this.active) return;
    this.offset = this.currentTime;
    this.stopNode();
    this.player.emit('pause');
  }

  seek(time) {
    const wasPlaying = this.active;
    this.offset = Math.max(0, Math.min(time, this.duration));
    if (wasPlaying) {
      this.stopNode();
      this.play();
    }
    this.player.emit('seek', { time: this.offset });
  }

  /** Tear down the current source node without emitting events. */
  stopNode() {
    if (!this.node) return;
    this.active = false;
    try { this.node.stop(); } catch { /* already stopped */ }
    this.node.disconnect();
    this.node = null;
  }

  teardown() { this.stopNode(); }
}

/**
 * ElementSource — an <audio>/<video> element feeding the graph through a
 * MediaElementAudioSourceNode. The element owns the transport, so everything
 * here delegates to it, and its own events are mirrored so the engine stays
 * in sync even when something else drives playback (native controls, another
 * script). Streams rather than decoding up front, which matters for long
 * files, and loads under rules that also permit `file://`.
 *
 * Caveat worth knowing: media feeding Web Audio is subject to CORS. A
 * cross-origin element without permissive headers still plays audibly but
 * delivers *silence* to the graph, so every band reads zero and the
 * visualizations sit dead. Same-origin, or `crossOrigin` set before the src,
 * is what keeps the analyzer fed.
 */
class ElementSource {
  constructor(player, el) {
    this.player = player;
    this.el = el;

    let node = elementSources.get(el);
    if (!node) {
      node = player.ctx.createMediaElementSource(el);
      elementSources.set(el, node);
    }
    this.node = node;
    node.connect(player.output);

    this.listeners = {
      play: () => player.emit('play'),
      pause: () => player.emit('pause'),
      ended: () => player.emit('ended'),
      seeked: () => player.emit('seek', { time: el.currentTime }),
    };
    for (const [event, fn] of Object.entries(this.listeners)) el.addEventListener(event, fn);
  }

  get duration() {
    const d = this.el.duration;
    return Number.isNaN(d) ? 0 : d;   // Infinity for live streams
  }

  get playing() { return !this.el.paused && !this.el.ended; }
  get currentTime() { return this.el.currentTime; }

  play() {
    // The element emits 'play' itself, which our listener re-emits.
    const started = this.el.play();
    if (started?.catch) started.catch((err) => console.warn('SongPlayer: play rejected', err));
  }

  pause() { this.el.pause(); }

  seek(time) {
    const max = Number.isFinite(this.duration) ? this.duration : time;
    this.el.currentTime = Math.max(0, Math.min(time, max));
  }

  teardown() {
    for (const [event, fn] of Object.entries(this.listeners)) {
      this.el.removeEventListener(event, fn);
    }
    this.node.disconnect(this.player.output);
  }
}

/**
 * LiveSource — an arbitrary AudioNode someone else owns: a mic stream, a
 * synth, an existing graph. There is no transport to expose, so play/pause/
 * seek are no-ops.
 *
 * `currentTime` still advances, reporting seconds since the node was
 * connected. The timeline is driven by this clock, so reporting a frozen zero
 * would pin every window to the start of the song forever.
 */
class LiveSource {
  constructor(player, node) {
    if (node.context !== player.ctx) {
      throw new Error(
        'SongPlayer: node belongs to a different AudioContext. Build it with '
        + 'the player\'s context (viz.player.ctx), or pass that context to '
        + 'MusicViz as `audioContext`.',
      );
    }
    this.player = player;
    this.node = node;
    this.startedAt = player.ctx.currentTime;
    node.connect(player.output);
  }

  get duration() { return Infinity; }
  get playing() { return true; }
  get currentTime() { return this.player.ctx.currentTime - this.startedAt; }

  play() {}
  pause() {}
  seek() {}

  teardown() { this.node.disconnect(this.player.output); }
}

/**
 * SongPlayer — feeds audio into the graph and exposes transport. Everything
 * reaches the speakers through an output GainNode that the Analyzer taps, so
 * the analyzer neither knows nor cares which kind of source is upstream.
 *
 * `load()` accepts four things:
 *
 *   URL string      fetched and decoded into an AudioBuffer (needs http(s):
 *                   — fetch is blocked on file://)
 *   File / Blob     decoded the same way, no network involved, so this path
 *                   works from file:// (e.g. an <input type="file">)
 *   HTMLMediaElement  wired through a MediaElementAudioSourceNode; the
 *                   element keeps ownership of the transport
 *   AudioNode       connected as-is; no transport
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

  async load(song) {
    this.teardown();

    if (isMediaElement(song)) {
      this.source = new ElementSource(this, song);
      await whenMetadata(song);
    } else if (isAudioNode(song)) {
      this.source = new LiveSource(this, song);
    } else {
      const arrayBuffer = song instanceof Blob
        ? await song.arrayBuffer()
        : await (await fetch(song)).arrayBuffer();
      this.source = new BufferSource(this, await this.ctx.decodeAudioData(arrayBuffer));
    }

    this.emit('load', { duration: this.duration });
  }

  get duration() { return this.source?.duration ?? 0; }
  get currentTime() { return this.source?.currentTime ?? 0; }
  get playing() { return this.source?.playing ?? false; }

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

  pause() { this.source?.pause(); }

  seek(time) { this.source?.seek(time); }

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
