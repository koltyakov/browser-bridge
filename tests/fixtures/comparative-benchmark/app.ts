// Classic-script fixture, compiled once by the controller and served on both origins.
(() => {
  const body = document.body;
  const record = body.dataset.record ?? 'main';
  const task = body.dataset.task ?? '';
  const effect = async (operation: string, value = '') => {
    const response = await fetch('/effect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation, record, value }),
    });
    if (!response.ok) throw new Error('Fixture write failed');
    return response.json();
  };
  const status = document.querySelector<HTMLElement>('[role=status]');
  document.querySelector('form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = document.querySelector<HTMLInputElement>('input')?.value ?? '';
    void effect('save', value).then(() => {
      if (status) status.textContent = `Saved ${value}`;
    });
  });
  document.querySelector('#dashboard')?.addEventListener('click', (event) => {
    event.preventDefault();
    history.pushState({}, '', '/dashboard');
    void effect('route').then(() => {
      const heading = document.querySelector('h1');
      if (heading) heading.textContent = 'Dashboard';
    });
  });
  for (const operation of ['first', 'late', 'probe']) {
    document.getElementById(operation)?.addEventListener('click', () => {
      void effect(operation).then(() => {
        if (status) status.textContent = `${operation} finished`;
      });
    });
  }
  document.getElementById('confirm')?.addEventListener('click', () => {
    void effect('confirm').then(async () => {
      if (confirm('Save the main profile?')) await effect('save', 'confirmed');
      else await effect('dismiss');
      if (status) status.textContent = 'Dialog resolved';
    });
  });
  // Controller dispatches this event only at the declared inspection boundary.
  document.addEventListener('benchmark-replace', () => {
    const previous = document.getElementById('save');
    if (!previous) return;
    if (task === 'stale-ambiguous') {
      previous.outerHTML = '<button type="submit">Save</button><button type="submit">Save</button>';
    } else {
      previous.replaceWith(previous.cloneNode(true));
    }
  });
})();
