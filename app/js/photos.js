// Photo preparation in the browser: scale down, convert to JPEG and encode as base64.

// Long edge after scaling. High enough for MEDIA_RESOLUTION_HIGH to read package labels,
// small enough to keep 4 photos well below the 20 MB request limit of the Gemini API.
export const MAX_EDGE_PX = 3072;
export const JPEG_QUALITY = 0.88;

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function shrink(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
}

/**
 * Returns the photo ready for upload, plus a preview URL.
 * @param {File} file Photo from the camera or the gallery.
 * @returns {Promise<{data: string, mimeType: string, previewUrl: string}>}
 */
export async function preparePhoto(file) {
  let blob = null;
  try {
    blob = await shrink(file);
  } catch {
    // The browser cannot decode the format; upload the original
  }
  blob ??= file;
  return {
    data: await blobToBase64(blob),
    mimeType: blob.type || "image/jpeg",
    previewUrl: URL.createObjectURL(blob),
  };
}
