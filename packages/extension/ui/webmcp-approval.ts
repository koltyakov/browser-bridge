(() => {
  const approvalId = location.hash.slice(1);
  const approveButton = document.getElementById('approve') as HTMLButtonElement;
  const denyButton = document.getElementById('deny') as HTMLButtonElement;
  const status = document.getElementById('status') as HTMLElement;

  function show(id: string, value: unknown) {
    const element = document.getElementById(id);
    if (element) {
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      element.textContent = (text ?? '').replace(
        /[\u202a-\u202e\u2066-\u2069]/gu,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
      );
    }
  }

  async function decide(approved: boolean) {
    approveButton.disabled = true;
    denyButton.disabled = true;
    try {
      await chrome.runtime.sendMessage({
        type: 'webmcp.approval.decide',
        id: approvalId,
        approved,
      });
      window.close();
    } catch {
      status.textContent =
        'This request expired or Browser Bridge disconnected. No new approval was granted.';
    }
  }

  approveButton.addEventListener('click', () => {
    void decide(true);
  });
  denyButton.addEventListener('click', () => {
    void decide(false);
  });

  void chrome.runtime
    .sendMessage({ type: 'webmcp.approval.get', id: approvalId })
    .then((raw) => {
      const response = raw as {
        ok?: boolean;
        details?: { origin: string; tabId: number; tool: unknown; arguments: unknown };
      };
      if (!response.ok || !response.details) throw new Error('Expired request');
      const { origin, tabId, tool, arguments: input } = response.details;
      const metadata = tool as { name?: string };
      show('scope', `${origin}\nTab ${tabId}`);
      show('tool-name', metadata.name);
      show('metadata', tool);
      show('arguments', input);
      const request = document.getElementById('request');
      if (request) request.hidden = false;
      status.textContent = 'Review this request before approving.';
      approveButton.disabled = false;
      denyButton.focus();
    })
    .catch(() => {
      status.textContent = 'This request is missing or expired. Close this window.';
    });
})();
