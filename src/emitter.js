/**
 * Minimal event emitter. Everything in the framework that broadcasts
 * (player, analyzer, engine) extends or embeds one of these.
 */
export class Emitter {
  #listeners = new Map();

  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this.#listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    this.#listeners.get(event)?.forEach((fn) => fn(payload));
  }
}
