// @ts-check

const MAX_LOG_ENTRIES = 80;

/** @type {Record<string, unknown>} */
let fixtureState = {};
let sequence = 0;
let networkRun = 0;
let focusReplacementGeneration = 0;
let inputReplacementGeneration = 0;
let controlledValue = '';
let inputReplacementValue = '';

/** @param {string} id */
function element(id) {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`Missing fixture element #${id}`);
  }
  return found;
}

function renderState() {
  const output = element('fixture-state');
  output.textContent = JSON.stringify(fixtureState, null, 2);
  output.dataset.fixtureReady = 'true';
}

/**
 * @param {string} event
 * @param {unknown} [detail]
 */
function record(event, detail = true) {
  sequence += 1;
  fixtureState[event] = detail;
  fixtureState.lastEvent = event;
  fixtureState.sequence = sequence;
  renderState();

  const item = document.createElement('li');
  item.dataset.event = event;
  item.textContent = `${sequence}: ${event} = ${JSON.stringify(detail)}`;
  const log = element('fixture-log');
  log.append(item);
  while (log.children.length > MAX_LOG_ENTRIES) {
    log.firstElementChild?.remove();
  }
}

/** @param {string} id */
function button(id) {
  const found = element(id);
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`Fixture element #${id} is not a button.`);
  }
  return found;
}

function renderControlledInput() {
  const host = element('controlled-input-host');
  host.replaceChildren();
  const label = document.createElement('label');
  label.htmlFor = 'controlled-input';
  label.textContent = 'Controlled input';
  const input = document.createElement('input');
  input.id = 'controlled-input';
  input.dataset.fixture = 'controlled-rerendering-input';
  input.value = controlledValue;
  input.addEventListener('input', () => {
    controlledValue = input.value;
    record('controlledInput', controlledValue);
    renderControlledInput();
  });
  host.append(label, input);
}

function renderFocusReplacementInput() {
  const host = element('focus-replacement-host');
  host.replaceChildren();
  const label = document.createElement('label');
  label.htmlFor = 'focus-replacement-input';
  label.textContent = 'Replaced on first focus';
  const input = document.createElement('input');
  input.id = 'focus-replacement-input';
  input.dataset.fixture = 'focus-replacement-input';
  input.dataset.generation = String(focusReplacementGeneration);
  input.addEventListener('focus', () => {
    if (focusReplacementGeneration === 0) {
      focusReplacementGeneration += 1;
      record('focusReplacement', { generation: focusReplacementGeneration });
      renderFocusReplacementInput();
    }
  });
  host.append(label, input);
}

function renderInputReplacementInput() {
  const host = element('input-replacement-host');
  host.replaceChildren();
  const label = document.createElement('label');
  label.htmlFor = 'input-replacement-input';
  label.textContent = 'Replaced after each input';
  const input = document.createElement('input');
  input.id = 'input-replacement-input';
  input.dataset.fixture = 'input-replacement-input';
  input.dataset.generation = String(inputReplacementGeneration);
  input.value = inputReplacementValue;
  input.addEventListener('input', () => {
    inputReplacementValue = input.value;
    inputReplacementGeneration += 1;
    record('inputReplacement', {
      generation: inputReplacementGeneration,
      value: inputReplacementValue,
    });
    renderInputReplacementInput();
  });
  host.append(label, input);
}

function drawCanvas() {
  const canvas = element('coordinate-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    return;
  }
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#fff7ed';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#172554';
  context.beginPath();
  context.moveTo(canvas.width / 2, 0);
  context.lineTo(canvas.width / 2, canvas.height);
  context.moveTo(0, canvas.height / 2);
  context.lineTo(canvas.width, canvas.height / 2);
  context.stroke();
}

/** @returns {Promise<string>} */
function requestXhr() {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/resource/xhr');
    xhr.timeout = 1_500;
    xhr.addEventListener('load', () => resolve(`xhr:${xhr.status}`));
    xhr.addEventListener('error', () => reject(new Error('xhr:error')));
    xhr.addEventListener('timeout', () => reject(new Error('xhr:timeout')));
    xhr.send();
  });
}

/** @param {number} run */
function loadDynamicScript(run) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `/resource/dynamic.js?run=${run}`;
    script.addEventListener('load', () => resolve('script:loaded'));
    script.addEventListener('error', () => reject(new Error('script:error')));
    element('dynamic-resource-host').append(script);
  });
}

/** @param {number} run */
function loadDynamicImage(run) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.alt = '';
    image.src = `/resource/dynamic.svg?run=${run}`;
    image.addEventListener('load', () => resolve('image:loaded'));
    image.addEventListener('error', () => reject(new Error('image:error')));
    element('dynamic-resource-host').append(image);
  });
}

/** @returns {Promise<string>} */
function openFixtureWebSocket() {
  return new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    const timer = window.setTimeout(() => {
      socket.close();
      reject(new Error('websocket:timeout'));
    }, 1_500);
    socket.addEventListener('message', (event) => {
      window.clearTimeout(timer);
      const result = `websocket:${String(event.data)}`;
      socket.close();
      resolve(result);
    });
    socket.addEventListener('error', () => {
      window.clearTimeout(timer);
      reject(new Error('websocket:error'));
    });
  });
}

/** @param {PromiseSettledResult<unknown>} result */
function settledSummary(result) {
  if (result.status === 'fulfilled') {
    return String(result.value);
  }
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

async function reproduceNetworkSet() {
  networkRun += 1;
  const run = networkRun;
  const output = element('network-output');
  output.textContent = `Network set ${run} running`;
  element('dynamic-resource-host').replaceChildren();

  const abortController = new AbortController();
  const abortTimer = window.setTimeout(() => abortController.abort(), 1_500);
  const tasks = [
    fetch(`/resource/fetch?run=${run}`).then((response) => `fetch:${response.status}`),
    requestXhr(),
    loadDynamicScript(run),
    loadDynamicImage(run),
    fetch('/resource/cache').then(async (response) => {
      await response.text();
      const repeated = await fetch('/resource/cache');
      return `cache:${response.status},cache-repeat:${repeated.status}`;
    }),
    fetch(`/resource/slow?delay=300&run=${run}`).then((response) => `slow:${response.status}`),
    fetch(`/resource/fail?run=${run}`).then((response) => `http-failure:${response.status}`),
    fetch(`/resource/abort?run=${run}`, { signal: abortController.signal }).then(
      (response) => `abort-unexpected:${response.status}`
    ),
    openFixtureWebSocket(),
  ];
  const results = await Promise.allSettled(tasks);
  window.clearTimeout(abortTimer);
  const summary = results.map(settledSummary);
  output.textContent = `Network set ${run} complete`;
  record('networkReproduce', { run, results: summary });
}

function initializeInteractions() {
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (target instanceof HTMLElement && target.dataset.action) {
      record(target.dataset.action, 'click');
    }
  });

  const customButton = element('custom-button');
  customButton.addEventListener('keydown', (event) => {
    if (event instanceof KeyboardEvent && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      record('customButtonKeyboard', event.key);
    }
  });

  button('menu-button').addEventListener('click', () => {
    const menu = element('custom-menu');
    const expanded = menu.hidden;
    menu.hidden = !expanded;
    button('menu-button').setAttribute('aria-expanded', String(expanded));
    record('menuExpanded', expanded);
  });

  element('custom-menu').addEventListener('click', (event) => {
    if (event.target instanceof HTMLElement && event.target.getAttribute('role') === 'menuitem') {
      record('menuSelection', event.target.textContent?.trim() ?? '');
    }
  });

  button('overlay-toggle').addEventListener('click', () => {
    const overlay = element('blocking-overlay');
    overlay.hidden = !overlay.hidden;
    record('overlayVisible', !overlay.hidden);
  });

  const dragSource = element('drag-source');
  dragSource.addEventListener('dragstart', (event) => {
    if (event instanceof DragEvent) {
      event.dataTransfer?.setData('text/plain', 'fixture-drag-payload');
      record('dragStarted');
    }
  });
  const dropTarget = element('drop-target');
  dropTarget.addEventListener('dragover', (event) => event.preventDefault());
  dropTarget.addEventListener('drop', (event) => {
    event.preventDefault();
    const payload = event instanceof DragEvent ? event.dataTransfer?.getData('text/plain') : '';
    record('dropReceived', payload || 'drop-without-payload');
  });

  const canvas = element('coordinate-canvas');
  canvas.addEventListener('click', (event) => {
    if (!(canvas instanceof HTMLCanvasElement) || !(event instanceof MouseEvent)) {
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    const point = {
      x: Math.round(((event.clientX - bounds.left) * canvas.width) / bounds.width),
      y: Math.round(((event.clientY - bounds.top) * canvas.height) / bounds.height),
    };
    element('canvas-output').textContent = `Canvas click ${point.x},${point.y}`;
    record('canvasClick', point);
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      element('shortcut-output').textContent = 'Shortcut received';
      record('keyboardShortcut', 'primary+shift+k');
    }
  });

  button('alert-button').addEventListener('click', () => {
    alert('Fixture alert');
    record('alertClosed');
  });
  button('confirm-button').addEventListener('click', () => {
    record('confirmResult', confirm('Fixture confirm'));
  });
  button('prompt-button').addEventListener('click', () => {
    record('promptResult', prompt('Fixture prompt', 'fixture-default'));
  });
  button('consecutive-dialog-button').addEventListener('click', () => {
    alert('Fixture consecutive dialog 1');
    alert('Fixture consecutive dialog 2');
    record('consecutiveDialogsClosed', 2);
  });

  const beforeUnloadToggle = element('beforeunload-toggle');
  window.addEventListener('beforeunload', (event) => {
    if (beforeUnloadToggle instanceof HTMLInputElement && beforeUnloadToggle.checked) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  beforeUnloadToggle.addEventListener('change', () => {
    if (beforeUnloadToggle instanceof HTMLInputElement) {
      record('beforeunloadArmed', beforeUnloadToggle.checked);
    }
  });

  button('push-state-button').addEventListener('click', () => {
    history.pushState({ fixture: 'push' }, '', `/spa/push-${sequence + 1}`);
    record('navigation', { kind: 'pushState', url: location.href });
    updateUrlOutput();
  });
  button('replace-state-button').addEventListener('click', () => {
    history.replaceState({ fixture: 'replace' }, '', `/spa/replace-${sequence + 1}`);
    record('navigation', { kind: 'replaceState', url: location.href });
    updateUrlOutput();
  });
  button('history-back-button').addEventListener('click', () => history.back());
  button('hash-button').addEventListener('click', () => {
    location.hash = `fixture-hash-${sequence + 1}`;
  });
  window.addEventListener('popstate', () => {
    record('navigation', { kind: 'popstate', url: location.href });
    updateUrlOutput();
  });
  window.addEventListener('hashchange', () => {
    record('navigation', { kind: 'hashchange', url: location.href });
    updateUrlOutput();
  });

  button('network-reproduce-button').addEventListener('click', () => {
    reproduceNetworkSet().catch((error) => {
      element('network-output').textContent = 'Network set failed unexpectedly';
      record('networkHarnessError', error instanceof Error ? error.message : String(error));
    });
  });
  button('network-cache-button').addEventListener('click', async () => {
    const response = await fetch('/resource/cache');
    record('cacheRequest', response.status);
  });
  button('reset-button').addEventListener('click', resetFixture);
}

function updateUrlOutput() {
  element('url-output').textContent = location.href;
}

function resetFixture() {
  fixtureState = { ready: true };
  sequence = 0;
  networkRun = 0;
  controlledValue = '';
  inputReplacementValue = '';
  focusReplacementGeneration = 0;
  inputReplacementGeneration = 0;
  element('fixture-log').replaceChildren();
  element('blocking-overlay').hidden = false;
  element('custom-menu').hidden = true;
  button('menu-button').setAttribute('aria-expanded', 'false');
  const beforeUnloadToggle = element('beforeunload-toggle');
  if (beforeUnloadToggle instanceof HTMLInputElement) {
    beforeUnloadToggle.checked = false;
  }
  element('network-output').textContent = 'Network set idle';
  element('shortcut-output').textContent = 'Shortcut idle';
  element('canvas-output').textContent = 'No canvas click';
  renderControlledInput();
  renderFocusReplacementInput();
  renderInputReplacementInput();
  drawCanvas();
  updateUrlOutput();
  renderState();
}

window.addEventListener('error', (event) => record('windowError', event.message));
window.addEventListener('unhandledrejection', (event) => {
  record('unhandledRejection', String(event.reason));
});

initializeInteractions();
resetFixture();
