'use strict';

const activeUrls = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'PRISMSHOT_PROCESS_IMAGE') return undefined;
  processImage(message).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: error?.message || String(error) });
  });
  return true;
});

async function processImage({ sourceDataUrl, crop, viewport, settings, metadata, destination }) {
  if (!sourceDataUrl) throw new Error('No captured image data was received.');

  const sourceBlob = await (await fetch(sourceDataUrl)).blob();
  const bitmap = await createImageBitmap(sourceBlob);

  try {
    let source = calculateSourceRect(bitmap, crop, viewport);
    if (settings.trimLetterbox) {
      source = await detectLetterbox(bitmap, source);
    }

    const target = calculateTargetDimensions(source.width, source.height, settings.upscale);
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Unable to create an image processing canvas.');

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.fillStyle = '#000';
    context.fillRect(0, 0, target.width, target.height);
    context.filter = settings.microContrast ? 'contrast(1.035) saturate(1.015)' : 'none';
    context.drawImage(
      bitmap,
      source.left,
      source.top,
      source.width,
      source.height,
      0,
      0,
      target.width,
      target.height
    );
    context.filter = 'none';

    if (settings.includeTimestampWatermark) {
      drawWatermark(context, target, metadata);
    }

    const format = normalizeFormat(settings.format);
    const mimeType = format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
    const quality = clamp(Number(settings.quality) || 0.94, 0.1, 1);
    const outputBlob = await canvasToBlob(canvas, mimeType, quality);
    const objectUrl = URL.createObjectURL(outputBlob);
    activeUrls.add(objectUrl);
    setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
      activeUrls.delete(objectUrl);
    }, 120_000);

    let clipboardOk = false;
    let clipboardError = null;
    if (destination === 'clipboard' || destination === 'both') {
      try {
        const clipboardBlob = outputBlob.type === 'image/png'
          ? outputBlob
          : await canvasToBlob(canvas, 'image/png', 1);
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': clipboardBlob })
        ]);
        clipboardOk = true;
      } catch (error) {
        clipboardError = error?.message || 'Clipboard image access was denied.';
      }
    }

    const thumbnailDataUrl = createThumbnail(canvas);

    return {
      ok: true,
      objectUrl,
      thumbnailDataUrl,
      clipboardOk,
      clipboardError,
      width: target.width,
      height: target.height,
      bytes: outputBlob.size,
      format,
      mimeType: outputBlob.type,
      trimmed: source.trimmed || false
    };
  } finally {
    bitmap.close();
  }
}

function calculateSourceRect(bitmap, crop, viewport) {
  if (!crop || !viewport?.width || !viewport?.height) {
    return { left: 0, top: 0, width: bitmap.width, height: bitmap.height };
  }

  const scaleX = bitmap.width / viewport.width;
  const scaleY = bitmap.height / viewport.height;
  const left = clamp(Math.round(crop.left * scaleX), 0, bitmap.width - 1);
  const top = clamp(Math.round(crop.top * scaleY), 0, bitmap.height - 1);
  const right = clamp(Math.round((crop.left + crop.width) * scaleX), left + 1, bitmap.width);
  const bottom = clamp(Math.round((crop.top + crop.height) * scaleY), top + 1, bitmap.height);

  return { left, top, width: right - left, height: bottom - top };
}

function calculateTargetDimensions(width, height, mode) {
  let scale = 1;
  if (mode === '2x') scale = 2;
  if (mode === '4k') scale = Math.max(1, Math.min(3840 / width, 2160 / height));
  if (mode === '8k') scale = Math.max(1, Math.min(7680 / width, 4320 / height));

  const maxDimension = 8192;
  const maxPixels = 40_000_000;
  scale = Math.min(scale, maxDimension / width, maxDimension / height, Math.sqrt(maxPixels / (width * height)));

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

async function detectLetterbox(bitmap, source) {
  const sampleScale = Math.min(1, 640 / source.width, 360 / source.height);
  const sampleWidth = Math.max(16, Math.round(source.width * sampleScale));
  const sampleHeight = Math.max(16, Math.round(source.height * sampleScale));
  const sample = document.createElement('canvas');
  sample.width = sampleWidth;
  sample.height = sampleHeight;
  const context = sample.getContext('2d', { willReadFrequently: true, alpha: false });
  context.drawImage(bitmap, source.left, source.top, source.width, source.height, 0, 0, sampleWidth, sampleHeight);
  const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;

  const maxTopBottom = Math.floor(sampleHeight * 0.2);
  const maxLeftRight = Math.floor(sampleWidth * 0.2);
  const top = scanDarkRows(pixels, sampleWidth, sampleHeight, 0, 1, maxTopBottom);
  const bottom = scanDarkRows(pixels, sampleWidth, sampleHeight, sampleHeight - 1, -1, maxTopBottom);
  const left = scanDarkColumns(pixels, sampleWidth, sampleHeight, 0, 1, maxLeftRight);
  const right = scanDarkColumns(pixels, sampleWidth, sampleHeight, sampleWidth - 1, -1, maxLeftRight);

  const trimTop = Math.round(top / sampleScale);
  const trimBottom = Math.round(bottom / sampleScale);
  const trimLeft = Math.round(left / sampleScale);
  const trimRight = Math.round(right / sampleScale);
  const width = source.width - trimLeft - trimRight;
  const height = source.height - trimTop - trimBottom;

  if (width < source.width * 0.6 || height < source.height * 0.6) return source;
  if (trimTop + trimBottom + trimLeft + trimRight < 4) return source;

  return {
    left: source.left + trimLeft,
    top: source.top + trimTop,
    width,
    height,
    trimmed: true
  };
}

function scanDarkRows(pixels, width, height, start, direction, limit) {
  let count = 0;
  for (let row = start; row >= 0 && row < height && count < limit; row += direction) {
    let dark = 0;
    let luminanceTotal = 0;
    for (let column = 0; column < width; column += 2) {
      const index = (row * width + column) * 4;
      const luminance = pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722;
      luminanceTotal += luminance;
      if (luminance < 18) dark += 1;
    }
    const samples = Math.ceil(width / 2);
    if (dark / samples > 0.92 && luminanceTotal / samples < 12) count += 1;
    else break;
  }
  return count;
}

function scanDarkColumns(pixels, width, height, start, direction, limit) {
  let count = 0;
  for (let column = start; column >= 0 && column < width && count < limit; column += direction) {
    let dark = 0;
    let luminanceTotal = 0;
    for (let row = 0; row < height; row += 2) {
      const index = (row * width + column) * 4;
      const luminance = pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722;
      luminanceTotal += luminance;
      if (luminance < 18) dark += 1;
    }
    const samples = Math.ceil(height / 2);
    if (dark / samples > 0.92 && luminanceTotal / samples < 12) count += 1;
    else break;
  }
  return count;
}

function drawWatermark(context, target, metadata) {
  const fontSize = Math.max(12, Math.round(Math.min(target.width, target.height) * 0.018));
  const padding = Math.max(10, Math.round(fontSize * 0.75));
  const label = `${metadata.site || 'video'} · ${formatMediaTime(metadata.currentTime)} · ${formatDate(metadata.capturedAt)}`;
  context.save();
  context.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  context.textBaseline = 'bottom';
  const metrics = context.measureText(label);
  const boxWidth = metrics.width + padding * 2;
  const boxHeight = fontSize + padding * 1.5;
  const x = target.width - boxWidth - padding;
  const y = target.height - boxHeight - padding;
  context.fillStyle = 'rgba(5, 6, 10, .68)';
  roundedRect(context, x, y, boxWidth, boxHeight, Math.max(6, fontSize * 0.35));
  context.fill();
  context.fillStyle = 'rgba(255, 255, 255, .92)';
  context.fillText(label, x + padding, y + boxHeight - padding * 0.6);
  context.restore();
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function createThumbnail(sourceCanvas) {
  const scale = Math.min(1, 320 / sourceCanvas.width, 180 / sourceCanvas.height);
  const width = Math.max(1, Math.round(sourceCanvas.width * scale));
  const height = Math.max(1, Math.round(sourceCanvas.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(sourceCanvas, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.72);
}

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error(`The browser could not encode ${mimeType}.`));
    }, mimeType, quality);
  });
}

function normalizeFormat(format) {
  return ['png', 'jpeg', 'webp'].includes(format) ? format : 'png';
}

function formatMediaTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatDate(value) {
  const date = new Date(value || Date.now());
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
