# Browser Bridge (BBX) Privacy Policy

Last updated: 2026-07-22

## Overview

Browser Bridge is a developer tool that lets a user-approved local agent inspect and interact with web pages in an explicitly enabled Chrome window. This policy describes how Browser Bridge handles data.

## What Browser Bridge can access

When you enable Browser Bridge for a Chrome window, Browser Bridge can access page data from tabs in that window as needed to fulfill your requests. Depending on the action you or your connected agent triggers, this can include:

- Page metadata such as URL, title, viewport, and scroll position
- DOM structure, element attributes, visible text, and layout information
- Computed styles, class/inline-style context, and semantic accessibility-tree data
- Console messages and uncaught page errors
- Network request metadata captured from page `fetch` and `XMLHttpRequest` activity, such as URL, method, status, timing, type, timestamp, and size
- Optional Chrome DevTools Protocol metadata for broader resource activity, including request ID, redacted URL, method, resource type, status, MIME type, protocol, cache indicators, redirects, failure reason, duration, and timestamp
- Current JavaScript dialog information when observable and explicitly requested, including dialog type, bounded message text, and bounded default prompt text
- `localStorage` and `sessionStorage` key metadata through ordinary inspection, and one exact value only through a deliberate `sensitive.read` request
- Screenshots or cropped image captures when explicitly requested
- User-triggered interaction data and results such as clicks, native pointer movement/drag, DOM or native text dispatch, key presses, selection changes, dialog decisions, and navigation actions
- Bounded semantic descriptors for optional stale-element recovery, represented in memory with normalized hashes and structural context rather than page text values or attributes written into the application DOM

All-resource network inspection excludes request and response bodies, cookies,
authorization values, and complete headers. It removes URL credentials and
fragments, replaces query parameter values with a redaction marker, and
summarizes data/blob URLs before returning them. Browser Bridge does not expose
these excluded values through that feature.

Browser Bridge is designed for local debugging and automation of the browser state you intentionally expose to it.

Ordinary storage inspection does not return value prefixes. Exact Web Storage
values require a separate key-specific sensitive read, are returned whole or
rejected whole, are never batched or retried automatically, and produce a
textual Sensitive access warning in Recent Activity. The warning stores the
source/category and key length, not the key or value. Powerful explicit methods
such as page evaluation and DOM inspection can still expose page data by design.
Every page evaluation is therefore labeled as Sensitive access in Recent
Activity, and its returned value and derived size are excluded from persisted
activity diagnostics.

## How Browser Bridge uses data

Browser Bridge uses this data only to provide its user-facing purpose: letting you inspect, test, and patch the currently enabled browser window from a connected developer tool or agent.

The normal local path sends request and response data through:

1. The Browser Bridge Chrome extension
2. The Browser Bridge native messaging host running on your machine
3. The agent client or IDE that you intentionally connect

The extension/native-host segment remains on the browser machine. If you explicitly configure an authenticated remote destination, the daemon can send bridge results over your own SSH tunnel or network route to that selected client. Browser Bridge does not operate a Browser Bridge cloud service and does not send extension data to developer-operated remote servers. Raw remote TCP is not presented as encrypted.

## Sharing and downstream processing

Browser Bridge shares page data only with the companion components and client you choose to connect. The normal path is local. If you explicitly configure Browser Bridge's authenticated remote proxy and your own tunnel or network route, the selected remote client can receive bridge results through that user-configured path; Browser Bridge does not provide or operate that network service.

Important:

- Browser Bridge itself does not sell your data.
- Browser Bridge itself does not use your data for advertising.
- Browser Bridge itself does not transfer page data to Browser Bridge-operated remote infrastructure.
- Your connected agent or IDE may, depending on its own configuration and provider, forward prompts, tool calls, or tool results to remote services. That downstream handling is controlled by the connected product, not by Browser Bridge.

You should review the privacy and retention practices of any connected agent, IDE, or model provider you use with Browser Bridge.

## Data retention

Browser Bridge keeps data only as long as needed for the current local session and feature behavior.

- Window enablement state is stored in session storage and cleared when disabled or when the browser session ends.
- Action log entries are stored for the current browser session only.
- Incidental action/log URLs remove credentials and fragments and redact query values; sensitive structured fields and local path prefixes are reduced before persistence.
- Console and fetch/XHR network buffers are bounded in memory and cleared when disabled or when the page state is reset.
- Optional CDP network capture is bounded in memory, explicitly started/stopped, expires after a safety interval, and is cleared on relevant debugger, tab, or access teardown.
- Dialog message/default prompt text is returned to the requesting caller when inspected but is excluded from persisted action-log summaries and size diagnostics.
- Exact sensitive values traverse the selected client in memory but are excluded from action summaries, diagnostic size counters, daemon logs, and automatic artifact storage.
- Patch rollback records and remembered element references live in the current document. Browser Bridge attempts patch rollback when access is disabled or switched, while page replacement/navigation removes document-local state.
- Hashed semantic descriptors used for optional stale recovery are bounded in memory with the element registry and do not survive the document/registry lifecycle.

Browser Bridge does not provide Browser Bridge-hosted accounts, sync, or long-term server-side storage.

## User control

You control when Browser Bridge can access browser data.

- Access is off by default.
- You explicitly enable Browser Bridge for a Chrome window.
- You can disable it at any time.
- Restricted Chrome pages are not scriptable through Browser Bridge.

## Remote code and runtime evaluation

Browser Bridge does not load remotely hosted extension code.

Browser Bridge can, when you explicitly invoke features such as page evaluation, execute user-requested expressions in the inspected page context through Chrome's documented Debugger API. That execution affects only the currently enabled browser window and is part of Browser Bridge's developer-tool functionality.

The same existing Debugger API permission is used only when requested for
native pointer/text dispatch, JavaScript dialog observation and explicit
handling, accessibility reads, screenshots, performance/CDP reads, interception,
and optional all-resource network capture. Browser Bridge does not silently
accept/dismiss dialogs and does not claim that accepted browser input proves an
application-level outcome.

## Security

- Extension code is packaged with the extension; Browser Bridge does not fetch and execute remote extension scripts.
- Communication with the companion host uses Chrome Native Messaging.
- Access is limited to the explicitly enabled browser window.
- The extension includes bounded buffers and document-local rollback records for temporary page patches, with rollback attempted when enabled-window access ends or switches.

## Chrome Web Store Limited Use statement

The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Changes

If Browser Bridge's data practices change, this policy will be updated before those changes are released.

## Contact

- GitHub Issues: https://github.com/koltyakov/browser-bridge/issues
