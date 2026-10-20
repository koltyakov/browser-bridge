# Files

Keep binary bytes out of model context. For agent-local files, the CLI reads and streams bounded chunks to the selected browser machine, assigns the completed handles once, then releases staging memory:

```bash
bbx upload --tab 123 --extension CONNECTION 'input[type=file]' ./report.pdf
bbx upload --remote office --tab 123 '#attachments' ./report.pdf ./chart.png
```

Files can be at most 16 MiB each and 32 MiB combined. The protocol equivalents are `files.stage`, `input.set_files`, and `files.release`, available through `browser_call`. `files.stage` returns only a handle, size, next offset, completion, and expiry. Handles are bound to the tab, access grant, agent session, and daemon connection. They expire after five minutes and are invalidated by worker restart. Keep multi-call transfers on one connection, such as the CLI upload helper or a persistent MCP client. After an uncertain chunk result, start a fresh transfer; never blindly replay the assignment.

For files already on the browser machine, use Chrome's native file-input operation without transferring bytes. It accepts a unique top-document selector and browser-local absolute paths, including files larger than the staging limit:

```bash
bbx call --tab 123 input.set_files '{"target":{"selector":"input[type=file]"},"paths":["/Users/me/Downloads/report.pdf"]}'
```

Staged assignment also accepts BBX element refs, including refs obtained inside frames. Empty `files:[]` clears the selection. `assigned:true` means the input accepted the files; wait for the application's upload-complete result before proceeding.

Authenticated downloads use the tab's fetch context and BBX's existing chunked artifacts. Browser CORS/CSP rules apply; this needs no additional extension permissions:

```bash
bbx call --tab 123 download.resource '{"url":"https://example.com/export"}'
bbx download --tab 123 --extension CONNECTION 'https://example.com/export' ./report.csv
```

The default size ceiling is 8 MiB and the maximum is 16 MiB. Streaming stops when decoded bytes exceed the limit, even without a Content-Length header. `timeoutMs` defaults to 30 seconds and can be at most 60 seconds. The result contains an artifact descriptor, never file bytes. Retrieve it with `artifact.read` on the same connection, or use `bbx download` to fetch, verify the SHA-256 checksum, and save it in one command. Artifacts are deleted when the owning connection closes. Remote destinations still require an encrypted tunnel, such as SSH, for transport confidentiality.

## Browser-native downloads

Use `download.start` for large files or URLs that page fetch cannot read. Chrome streams directly to the browser machine's Downloads directory, without BBX's artifact size limit. This uses the `downloads` permission. Browser authentication, download safety checks, disk limits, and server resume support still apply.

```bash
bbx call --tab 123 --extension CONNECTION download.start '{"url":"https://example.com/export","filename":"export.zip"}'
bbx call --tab 123 --extension CONNECTION download.status '{"downloadId":"HANDLE"}'
bbx call --tab 123 --extension CONNECTION download.pause '{"downloadId":"HANDLE"}'
bbx call --tab 123 --extension CONNECTION download.resume '{"downloadId":"HANDLE"}'
bbx call --tab 123 --extension CONNECTION download.cancel '{"downloadId":"HANDLE"}'
bbx call --tab 123 --extension CONNECTION download.release '{"downloadId":"HANDLE"}'
```

Treat `downloadId` as a secret capability. It works across CLI invocations in the same tab and access grant, and survives an extension worker restart. BBX exposes no general browser download-history search. `status` returns bytes received/total, state, pause/resume availability, and the browser-local filename. `saveAs:true` opens Chrome's save dialog; the default does not. Filenames must be single relative names, and collisions are uniquified. Release is allowed only after completion/cancellation and never deletes the file. Access revocation or tab closure cancels retained downloads. Completed handles expire after 24 hours when a new download prunes them. At most 32 handles are retained.

## Trusted image paste

```bash
bbx paste-image --tab 123 --extension CONNECTION '[contenteditable=true]' ./chart.png
```

The helper stages one PNG, focuses the editor, writes the image to the real system clipboard, dispatches Chrome's native paste command, and releases staging memory. MCP can use `files.stage`, `input.paste_image` with `target` and `transferId`, then `files.release` on one connection. The browser window and tab must already be focused, and the target must be an editable control in the top document. BBX revalidates focus before clipboard writing and before paste. No clipboard-read or extra clipboard permission is requested. This overwrites the clipboard. Inspect insertion before submitting; never automatically replay after uncertainty or focus loss.
