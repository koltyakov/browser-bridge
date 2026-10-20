// @ts-check

/** Activity lives in the isolated world. No input values, keys, URLs, or page markup are collected.
 * @param {'start' | 'drain' | 'status' | 'stop'} action @param {string} sessionId
 * @returns {{ epoch: string, active: boolean, events: Array<Record<string, unknown>>, dropped: number, missing?: boolean }} */
export function pageRecorder(action, sessionId) {
  /** @typedef {{ id: string, epoch: string, active: boolean, events: Array<Record<string, unknown>>, dropped: number, stop: () => void, flush: () => void, timer: ReturnType<typeof setTimeout> }} Recorder */
  const scope = /** @type {typeof globalThis & { __BBX_ACTIVITY_RECORDER__?: Recorder }} */ (
    globalThis
  );
  let state = scope.__BBX_ACTIVITY_RECORDER__;
  if (action === 'start') {
    if (state?.id === sessionId && state.active)
      return { epoch: state.epoch, active: true, events: [], dropped: state.dropped };
    state?.stop();
    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    const controller = new AbortController();
    /** @type {{ element: Element, at: number, count: number, label: string, role: string } | null} */
    let typing = null;
    let scrollAt = 0;
    let typingTimer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined);
    /** @param {Record<string, unknown>} event */
    function push(event) {
      if (!record.active) return;
      if (events.length >= 128) {
        events.shift();
        record.dropped++;
      }
      events.push(event);
    }
    function flush() {
      clearTimeout(typingTimer);
      if (typing) {
        push({
          type: 'input',
          at: typing.at,
          count: typing.count,
          label: typing.label,
          role: typing.role,
          value: '[redacted]',
          origin: 'trusted-event',
        });
        typing = null;
      }
    }
    const record = {
      id: sessionId,
      epoch: crypto.randomUUID(),
      active: true,
      events,
      dropped: 0,
      stop() {
        flush();
        record.active = false;
        controller.abort();
        clearTimeout(record.timer);
      },
      flush,
      timer: setTimeout(() => {
        record.stop();
      }, 300000),
    };
    scope.__BBX_ACTIVITY_RECORDER__ = record;
    state = record;
    /** @param {Element} element */
    function describe(element) {
      element =
        element.closest('button,[role="button"],input,textarea,select,a,[role="link"]') ?? element;
      const sensitive =
        element.matches('input[type="password"],[contenteditable], [contenteditable] *') ||
        element.closest('[data-private],[data-sensitive],[autocomplete*="password"]');
      // Names come from the event-time DOM. Never derive them from value, innerHTML or href.
      const text = sensitive
        ? ''
        : element.getAttribute('aria-label') ||
          (element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
            ? element.labels?.[0]?.textContent
            : '') ||
          (element instanceof HTMLButtonElement ? element.textContent : '') ||
          '';
      const label = text
        .slice(0, 160)
        .replace(
          /(?:bearer\s+\S+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:password|token|secret|key)\s*[:=]\s*\S+)/giu,
          '[redacted]'
        );
      return {
        label,
        role: (element.getAttribute('role') || element.tagName.toLowerCase()).slice(0, 40),
      };
    }
    /** @param {Event} event */
    function handle(event) {
      if (!event.isTrusted || !record.active) return;
      const element = event.composedPath().find((node) => node instanceof Element);
      if (!(element instanceof Element)) return;
      const at = Date.now();
      if (event.type === 'input') {
        if (typing?.element !== element) flush();
        typing ??= { element, at, count: 0, ...describe(element) };
        typing.count++;
        clearTimeout(typingTimer);
        typingTimer = setTimeout(flush, 400);
        return;
      }
      if (event.type === 'scroll') {
        if (at - scrollAt < 500) return;
        scrollAt = at;
      }
      flush();
      push({
        type: event.type,
        at,
        ...describe(element),
        origin: 'trusted-event',
        ...(event.type === 'scroll' ? { x: Math.round(scrollX), y: Math.round(scrollY) } : {}),
      });
    }
    for (const type of ['click', 'input', 'change', 'submit', 'scroll'])
      document.addEventListener(type, handle, {
        capture: true,
        passive: true,
        signal: controller.signal,
      });
  }
  if (!state || state.id !== sessionId)
    return { epoch: '', active: false, events: [], dropped: 0, missing: true };
  if (action === 'status')
    return { epoch: state.epoch, active: state.active, events: [], dropped: state.dropped };
  if (action === 'stop') state.stop();
  if (action === 'drain' || action === 'stop') {
    state.flush();
    const events = state.events.splice(0);
    const dropped = state.dropped;
    state.dropped = 0;
    return { epoch: state.epoch, active: state.active, events, dropped };
  }
  return { epoch: state.epoch, active: state.active, events: [], dropped: state.dropped };
}
