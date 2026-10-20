# Environment emulation

Use `emulation.apply` to reproduce a device layout or environmental failure. Settings merge per tab and hold a debugger session until reset or detach. `emulation.status` is a compact read and never attaches a debugger.

```bash
bbx call --tab 123 emulation.apply '{"device":"phone","network":"slow-3g","cpuRate":4}'
bbx call --tab 123 navigation.reload '{}'
bbx call --tab 123 emulation.status '{}'
bbx call --tab 123 emulation.reset '{}'
```

Device presets are `phone`, `tablet`, and `desktop`. Override metrics with `{"device":{"preset":"phone","width":412}}`. Presets change viewport, DPR, and touch. They do not turn Chrome into Safari.

Network presets are `offline`, `slow-3g`, `fast-3g`, `wifi`, and `unthrottled`. Explicit fields are `offline`, `latencyMs`, `downloadKbps`, and `uploadKbps`; throughput `-1` means unthrottled. Reload when testing page loading.

Other settings are `locale`, `timezoneId`, `cpuRate`, and `geolocation:{latitude,longitude,accuracy}`. Geolocation overrides do not grant website permissions. Locale changes Intl formatting; they do not rewrite request headers.

Reset after the experiment. A partial application can still have changed the tab. Reset attempts every owned setting and reports `failures` and `pendingReset`; retry cleanup if needed. Window-access cleanup also resets emulation. An external debugger detach clears ownership. Avoid mixing `viewport.resize` and device emulation in one experiment.
