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
  crop(typedMessage.image || '', typedMessage.rect || { x: 0, y: 0, width: 1, height: 1 }).then(sendResponse);
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
  const canvas = new OffscreenCanvas(rect.width, rect.height);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(croppedBlob);
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
async function blobToDataUrl(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
  return `data:${blob.type};base64,${base64}`;
}
