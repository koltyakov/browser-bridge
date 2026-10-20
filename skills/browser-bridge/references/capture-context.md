# Capture and runtime identity

Screenshot results include `context` with capture timestamps, tab ID, tab activity, window focus, document visibility/focus, and coordinate spaces. `null` means the lookup was unavailable. These flags are sampled before capture and do not prove that the user saw the image.

`rectSpace` is `viewport-css` for region requests and `document-css` for element and full-page requests. `pageClip` is the document-space CSS rectangle sent to CDP after adding the visual viewport offset. `dimensions` describes encoded image pixels. Use these fields when relating a screenshot to DOM boxes. A renderer screenshot can capture a background tab.

`health.ping` includes `loadedBuild` for the selected extension. `workerId` and `startedAt` identify its running service-worker instance. Packaged releases also include `sourceDigest`, a SHA-256 digest of the sorted staged paths and bytes before the build stamp is generated. Unpackaged checkouts report `null`. The stamp identifies the packaged sources; it is not a cryptographic attestation of the browser or machine.

After replacing an extension package, check both `extensionVersion` and `loadedBuild`. A different worker ID confirms a worker restart, while the source digest distinguishes packaged builds with the same version. Re-discover the connection ID after reload.
