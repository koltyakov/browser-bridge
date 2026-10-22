import {
  getSupportedProtocolVersions,
  isProtocolVersionSupported,
} from '../../../protocol/src/index.js';

export function compareProtocolVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number(part) || 0);
  const rightParts = right.split('.').map((part) => Number(part) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (delta !== 0) {
      return delta > 0 ? 1 : -1;
    }
  }
  return 0;
}

export function getVersionNegotiationPayload(requestedVersion: string | undefined): {
  supported_versions: readonly string[];
  deprecated_since?: string;
  migration_hint?: string;
} {
  const supportedVersions = getSupportedProtocolVersions();
  const latestSupported = supportedVersions[0];
  if (
    !requestedVersion ||
    !latestSupported ||
    isProtocolVersionSupported(requestedVersion, supportedVersions)
  ) {
    return { supported_versions: supportedVersions };
  }

  const localIsNewer = compareProtocolVersions(latestSupported, requestedVersion) > 0;
  return {
    supported_versions: supportedVersions,
    ...(localIsNewer ? { deprecated_since: latestSupported } : {}),
    migration_hint: localIsNewer
      ? `Browser Bridge extension is newer than the client protocol ${requestedVersion}. Update the Browser Bridge CLI/npm package to ${latestSupported} or later.`
      : `Browser Bridge extension is older than the client protocol ${requestedVersion}. Update the extension to a build that supports ${requestedVersion}.`,
  };
}
