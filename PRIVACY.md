# Browser Bridge (BBX) Privacy Policy

Last updated: 2026-03-27

## Overview

Browser Bridge is a developer tool that lets a user-approved local agent inspect and interact with web pages in an explicitly enabled Chrome window. This policy describes how Browser Bridge handles data.

## What Browser Bridge can access

When you enable Browser Bridge for a Chrome window, Browser Bridge can access page data from tabs in that window as needed to fulfill your requests. Depending on the action you or your connected agent triggers, this can include:

- Page metadata such as URL, title, viewport, and scroll position
- DOM structure, element attributes, visible text, and layout information
- Computed styles, matched rules, and accessibility-tree data
- Console messages and uncaught page errors
- Network request metadata captured from page `fetch` and `XMLHttpRequest` activity, such as URL, method, status, timing, and size
- `localStorage` and `sessionStorage` values when explicitly requested
- Screenshots or cropped image captures when explicitly requested
- User-triggered interaction data such as clicks, typing, key presses, selection changes, and navigation actions

Browser Bridge is designed for local debugging and automation of the browser state you intentionally expose to it.

## How Browser Bridge uses data

Browser Bridge uses this data only to provide its user-facing purpose: letting you inspect, test, and patch the currently enabled browser window from a connected developer tool or agent.

The extension sends request and response data locally through:

1. The Browser Bridge Chrome extension
2. The Browser Bridge native messaging host running on your machine
3. The local agent client or IDE that you intentionally connect

Browser Bridge does not operate a Browser Bridge cloud service and does not send extension data to developer-operated remote servers.

## Sharing and downstream processing

Browser Bridge shares page data only with the local companion components and local client you choose to connect.

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
- Console and network buffers are bounded in memory and cleared when disabled or when the page state is reset.
- Patch state and remembered element references are session-scoped and cleared on disable, page replacement, or navigation as needed.

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

## Security

- Extension code is packaged with the extension; Browser Bridge does not fetch and execute remote extension scripts.
- Communication with the companion host uses Chrome Native Messaging.
- Access is limited to the explicitly enabled browser window.
- The extension includes bounded buffers and session-scoped rollback for temporary page patches.

## Chrome Web Store Limited Use statement

The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Changes

If Browser Bridge's data practices change, this policy will be updated before those changes are released.

## Contact

- GitHub Issues: https://github.com/koltyakov/browser-bridge/issues
