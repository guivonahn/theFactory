/** Image detection and OS opener arguments. No network or process spawning. */

import { basename, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMAGE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif',
  '.tif', '.tiff', '.ico', '.heic', '.heif',
]);

const IMAGE_TOOLS = new Set(['read', 'write', 'edit', 'experimental_image_generate', 'browser']);
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.ico': 'image/x-icon',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

export function isImageMime(mime) {
  return typeof mime === 'string' && /^image\//i.test(mime.trim());
}

function cleanPathTarget(value) {
  return String(value ?? '').trim().replace(/^<|>$/g, '');
}

export function isImagePath(path) {
  if (typeof path !== 'string') return false;
  const target = cleanPathTarget(path);
  if (!target || /^data:/i.test(target)) return false;
  let pathname = target;
  if (/^https?:\/\//i.test(target)) {
    try { pathname = new URL(target).pathname; } catch { return false; }
  } else {
    pathname = target.split(/[?#]/, 1)[0];
  }
  try { pathname = decodeURIComponent(pathname); } catch {}
  return IMAGE_EXT.has(extname(pathname).toLowerCase());
}

function nameForTarget(target, path, url) {
  if (url) {
    try {
      const name = basename(decodeURIComponent(new URL(url).pathname));
      if (name) return name;
    } catch {}
    return url;
  }
  return basename(path ?? target) || String(target ?? 'image');
}

/** Normalize a file/URL target and add it once to the result set. */
function normalizeTarget(target, { dir, name, mime, images, keys }) {
  if (typeof target !== 'string') return;
  const original = target.trim();
  if (!original || /^data:/i.test(original)) return;

  let path = null;
  let url = null;
  try {
    if (/^https?:\/\//i.test(original)) {
      url = original;
    } else if (/^file:\/\//i.test(original)) {
      path = fileURLToPath(original);
    } else if (isAbsolute(original)) {
      path = original;
    } else {
      path = resolve(dir || process.cwd(), original);
    }
  } catch {
    return;
  }

  const key = url ? `url:${url}` : `path:${path}`;
  if (keys.has(key)) return;
  keys.add(key);
  const extension = extname(url ? new URL(url).pathname : path).toLowerCase();
  images.push({
    path,
    ...(url ? { url } : {}),
    uri: original,
    name: name || nameForTarget(original, path, url),
    mime: mime || MIME_BY_EXT[extension] || null,
  });
}

function markdownTargets(text) {
  if (typeof text !== 'string' || !text) return [];
  const targets = [];
  // The angle-bracket form permits spaces; the regular form stops at whitespace
  // so an optional Markdown title is not treated as part of the path.
  const markdown = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g;
  for (const match of text.matchAll(markdown)) targets.push(match[1] ?? match[2]);
  const html = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;
  for (const match of text.matchAll(html)) targets.push(match[1] ?? match[2] ?? match[3]);
  return targets.filter(Boolean);
}

/**
 * Extract images emitted by tools and text parts. Recursive state traversal is
 * depth/node bounded and cycle-safe because tool metadata may contain arbitrary
 * nested payloads. `options.text` lets parseRunLine include data.text as well.
 */
export function imagesFromPart(part, options = {}) {
  const images = [];
  const keys = new Set();
  const context = { dir: options?.dir, images, keys };
  if (!part || typeof part !== 'object') return images;

  try {
    // Bounded recursive search also covers state.metadata.content and the
    // nested state.metadata.metadata.content variants used by image tools.
    const stack = [{ value: part.state, depth: 0 }];
    const visited = new WeakSet();
    let visitedCount = 0;
    while (stack.length > 0 && visitedCount < 500) {
      const { value, depth } = stack.pop();
      if (!value || typeof value !== 'object' || visited.has(value)) continue;
      visited.add(value);
      visitedCount += 1;
      if (value.type === 'file' && isImageMime(value.mime)) {
        normalizeTarget(value.uri, { ...context, name: value.name, mime: value.mime });
      }
      if (depth >= 8) continue;
      if (Array.isArray(value)) {
        for (const entry of value) stack.push({ value: entry, depth: depth + 1 });
      } else {
        for (const entry of Object.values(value)) {
          if (entry && typeof entry === 'object') stack.push({ value: entry, depth: depth + 1 });
        }
      }
    }

    const tool = String(part.tool ?? part.name ?? part.state?.tool ?? '').trim();
    const input = part.state?.input;
    if (IMAGE_TOOLS.has(tool) && input && typeof input === 'object') {
      for (const target of [input.path, input.filePath, input.file]) {
        if (isImagePath(target)) normalizeTarget(target, context);
      }
    }

    const texts = [part.text, part.data?.text, options?.text];
    for (const text of texts) {
      for (const target of markdownTargets(text)) {
        if (/^https?:\/\//i.test(target) || isImagePath(target)) normalizeTarget(target, context);
      }
    }
  } catch {
    // Malformed tool output must never break JSONL parsing. Return any images
    // found before the bad entry rather than throwing into the render loop.
  }
  return images;
}

/** Return a detached-spawn-friendly OS opener command. */
export function openExternalCommand(target, platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [target] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', target] };
  return { command: 'xdg-open', args: [target] };
}
