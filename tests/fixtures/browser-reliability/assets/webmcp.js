// @ts-check

void (async () => {
  const availability = document.getElementById('availability');
  const result = document.getElementById('result');
  const context =
    /** @type {Document & { modelContext?: { registerTool: (tool: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<void> } }} */ (
      document
    ).modelContext;
  if (!availability || !result) return;
  if (!context) {
    availability.textContent = 'Native WebMCP unavailable. No polyfill installed.';
    return;
  }
  const controller = new AbortController();
  await context.registerTool(
    {
      name: 'fixture_set_status',
      description:
        'Set the visible status on this local fixture. No network or persistent changes.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string', maxLength: 100 } },
        required: ['value'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, consequentialHint: false },
      /** @param {{ value: string }} input */
      execute: async ({ value }) => {
        result.textContent = value;
        result.dataset.executions = String(Number(result.dataset.executions) + 1);
        return JSON.stringify({ status: value, executions: Number(result.dataset.executions) });
      },
    },
    { signal: controller.signal }
  );
  availability.textContent = 'Native tool registered.';
  document.getElementById('remove')?.addEventListener('click', () => {
    controller.abort();
    availability.textContent = 'Tool removed.';
  });
})().catch(() => {
  const availability = document.getElementById('availability');
  if (availability) availability.textContent = 'Native WebMCP registration failed.';
});
