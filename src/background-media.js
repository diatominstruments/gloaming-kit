const DEFAULTS = Object.freeze({
  fit: 'cover', opacity: 1, dim: 0, positionX: 0.5, positionY: 0.5,
  loop: true, playbackRate: 1, offset: 0,
});

export function backgroundSettings(patch = {}, base = DEFAULTS) {
  const result = { ...base };
  for (const [key, min, max] of [
    ['opacity', 0, 1], ['dim', 0, 1], ['positionX', 0, 1], ['positionY', 0, 1],
    ['playbackRate', 0.25, 4], ['offset', 0, Number.MAX_SAFE_INTEGER],
  ]) {
    if (patch[key] === undefined) continue;
    if (!Number.isFinite(patch[key])) throw new TypeError(`Background ${key} must be a finite number.`);
    result[key] = Math.max(min, Math.min(max, patch[key]));
  }
  if (patch.fit !== undefined) {
    if (!['cover', 'contain', 'stretch'].includes(patch.fit)) throw new TypeError('Background fit must be cover, contain, or stretch.');
    result.fit = patch.fit;
  }
  if (patch.loop !== undefined) result.loop = Boolean(patch.loop);
  return result;
}

/** Destination rectangle; canvas clipping handles the cropped edges in cover mode. */
export function backgroundRect(sw, sh, width, height, { fit, positionX, positionY }) {
  if (fit === 'stretch') return [0, 0, width, height];
  const scale = (fit === 'contain' ? Math.min : Math.max)(width / sw, height / sh);
  const w = sw * scale;
  const h = sh * scale;
  return [(width - w) * positionX, (height - h) * positionY, w, h];
}

export function backgroundTime(time, duration, settings) {
  const target = Math.max(0, time) * settings.playbackRate + settings.offset;
  if (!(duration > 0) || !Number.isFinite(duration)) return { time: target, ended: false };
  return settings.loop
    ? { time: target % duration, ended: false }
    : { time: Math.min(target, Math.max(0, duration - 0.001)), ended: target >= duration };
}

function seekVideo(media, time, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); media.removeEventListener('seeked', done); media.removeEventListener('error', failed); signal.removeEventListener('abort', aborted); };
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Could not seek the background video.')); };
    const aborted = () => { cleanup(); reject(new DOMException('Background load was canceled.', 'AbortError')); };
    const timer = setTimeout(failed, 8000);
    media.addEventListener('seeked', done); media.addEventListener('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) return aborted();
    try { media.currentTime = time; }
    catch (error) { cleanup(); reject(error); }
  });
}

/** Owns an image/video and its object URL. It never creates an audible audio path. */
export class MediaBackground {
  constructor({ source, type, ...settings }, onError = () => {}) {
    if (!(typeof source === 'string' || source instanceof Blob)) throw new TypeError('Background source must be a URL string or a File/Blob.');
    this.type = type ?? (/^video\//.test(source.type ?? '') || /\.(mp4|webm|mov|m4v|ogv)(?:[?#]|$)/i.test(typeof source === 'string' ? source : source.name ?? '') ? 'video' : 'image');
    if (!['image', 'video'].includes(this.type)) throw new TypeError('Background type must be image or video.');
    this.settings = backgroundSettings(settings);
    this.source = source;
    this.onError = onError;
    this.controller = new AbortController();
    this.media = this.type === 'video' ? document.createElement('video') : new Image();
    this.ready = false;
    this.wantsPlay = false;
    this.disposed = false;
  }

  async load() {
    const media = this.media;
    media.crossOrigin = 'anonymous';
    if (this.type === 'video') {
      media.muted = true;
      media.defaultMuted = true;
      media.playsInline = true;
      media.preload = 'auto';
    }
    const url = typeof this.source === 'string' ? this.source : (this.objectUrl = URL.createObjectURL(this.source));
    await new Promise((resolve, reject) => {
      const event = this.type === 'video' ? 'loadeddata' : 'load';
      const signal = this.controller.signal;
      const cleanup = () => { clearTimeout(timer); media.removeEventListener(event, loaded); media.removeEventListener('error', failed); signal.removeEventListener('abort', aborted); };
      const loaded = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error(`Could not decode background ${this.type}. Check the format and, for remote URLs, CORS permissions.`)); };
      const aborted = () => { cleanup(); reject(new DOMException('Background load was canceled.', 'AbortError')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Background media took too long to load.')); }, 30000);
      media.addEventListener(event, loaded);
      media.addEventListener('error', failed);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) return aborted();
      media.src = url;
      if (this.type === 'video') media.load();
    });
    // MediaRecorder WebM files may omit duration metadata. Seeking to the end
    // lets the decoder discover it before song-clock looping is calculated.
    if (this.type === 'video' && !Number.isFinite(media.duration)) {
      await seekVideo(media, 1e10, this.controller.signal);
      if (!Number.isFinite(media.duration)) throw new Error('Background video must be a finite, seekable clip.');
      await seekVideo(media, 0, this.controller.signal);
    }
    if (this.disposed) throw new DOMException('Background load was canceled.', 'AbortError');
    // Fail before touching the engine canvas if the source would taint capture.
    const probe = document.createElement('canvas');
    probe.width = probe.height = 1;
    const ctx = probe.getContext('2d');
    ctx.drawImage(media, 0, 0, 1, 1);
    ctx.getImageData(0, 0, 1, 1);
    this.ready = true;
    this.update({});
    if (this.type === 'video') media.addEventListener('error', () => {
      this.ready = false;
      this.onError(new Error('Background video playback failed. Relink the video or choose a supported format.'));
    }, { signal: this.controller.signal });
    return this;
  }

  update(patch) {
    this.settings = backgroundSettings(patch, this.settings);
    if (this.type === 'video') {
      this.media.loop = this.settings.loop;
      this.media.playbackRate = this.settings.playbackRate;
    }
  }

  sync(time, playing, force = false) {
    if (this.type !== 'video' || !this.ready || this.disposed) return;
    const media = this.media;
    const target = backgroundTime(time, media.duration, this.settings);
    if ((force || !media.seeking) && Math.abs(media.currentTime - target.time) > (force ? 0.001 : 0.18)) media.currentTime = target.time;
    const shouldPlay = playing && !target.ended;
    if (!shouldPlay) {
      media.pause(); this.wantsPlay = false;
    } else if (!this.wantsPlay || (force && media.paused)) {
      this.wantsPlay = true;
      const generation = (this.playGeneration ?? 0) + 1;
      this.playGeneration = generation;
      media.play().catch((error) => {
        // Pause/seek/replacement may interrupt a pending play promise normally.
        if (!this.disposed && this.wantsPlay && generation === this.playGeneration && error.name !== 'AbortError') this.onError(error);
      });
    }
  }

  draw(ctx, width, height) {
    if (!this.ready || this.disposed || this.settings.opacity === 0 || (this.type === 'video' && this.media.readyState < 2)) return;
    const sw = this.media.naturalWidth ?? this.media.videoWidth;
    const sh = this.media.naturalHeight ?? this.media.videoHeight;
    if (!(sw > 0 && sh > 0)) return;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    ctx.globalAlpha = this.settings.opacity;
    ctx.drawImage(this.media, ...backgroundRect(sw, sh, width, height, this.settings));
    if (this.settings.dim > 0) {
      ctx.globalAlpha = this.settings.dim;
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.restore();
  }

  get info() {
    return { type: this.type, width: this.media.naturalWidth ?? this.media.videoWidth,
      height: this.media.naturalHeight ?? this.media.videoHeight, ...this.settings };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    if (this.type === 'video') this.media.pause();
    this.media.removeAttribute('src');
    if (this.type === 'video') this.media.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.ready = false;
  }
}
