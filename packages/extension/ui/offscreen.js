// @ts-check

/**
 * @typedef {{
 *   type?: string,
 *   image?: string,
 *   rect?: { x: number, y: number, width: number, height: number }
 * }} CropMessage
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'bridge.crop-image') {
    return false;
  }

  const typedMessage = /** @type {CropMessage} */ (message);
  crop(typedMessage.image || '', typedMessage.rect || { x: 0, y: 0, width: 1, height: 1 }).then(
    sendResponse
  );
  return true;
});

/**
 * @param {string} imageUrl
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @returns {Promise<string>}
 */
async function crop(imageUrl, rect) {
  const response = await fetch(imageUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  // Clamp crop rect to bitmap bounds to prevent out-of-bounds draws
  const x = Math.max(0, Math.min(rect.x, bitmap.width - 1));
  const y = Math.max(0, Math.min(rect.y, bitmap.height - 1));
  const w = Math.max(1, Math.min(rect.width, bitmap.width - x));
  const h = Math.max(1, Math.min(rect.height, bitmap.height - y));

  const canvas = new OffscreenCanvas(w, h);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to create 2D offscreen canvas context.');
  }
  context.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
  bitmap.close();
  const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(croppedBlob);
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
async function blobToDataUrl(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192))));
  }
  const base64 = btoa(chunks.join(''));
  return `data:${blob.type};base64,${base64}`;
}
