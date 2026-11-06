import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  IMAGE_EXT,
  imagesFromPart,
  isImageMime,
  isImagePath,
  openExternalCommand,
} from '../src/media.js';

test('image extensions and MIME detection are case-insensitive', () => {
  for (const extension of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.heic']) {
    assert.equal(IMAGE_EXT.has(extension), true, `${extension} is a known image extension`);
  }
  assert.equal(isImageMime('image/png'), true);
  assert.equal(isImageMime('  IMAGE/JPEG '), true);
  assert.equal(isImageMime('text/plain'), false);
  assert.equal(isImageMime(null), false);
});

test('isImagePath handles extensions, query strings, URLs, and non-images', () => {
  assert.equal(isImagePath('/tmp/shot.PNG'), true);
  assert.equal(isImagePath('relative/dir/pic.webp?v=2'), true);
  assert.equal(isImagePath('https://example.com/assets/a.jpg?size=2'), true);
  assert.equal(isImagePath('https://example.com/no-extension'), false);
  assert.equal(isImagePath('notes.txt'), false);
  assert.equal(isImagePath('data:image/png;base64,abc'), false);
  assert.equal(isImagePath(''), false);
  assert.equal(isImagePath(null), false);
});

test('imagesFromPart finds file content and resolves names and MIME', () => {
  const images = imagesFromPart({
    type: 'tool',
    tool: 'read',
    state: {
      metadata: {
        content: [{ type: 'file', mime: 'image/png', uri: 'file:///tmp/one.png', name: 'one.png' }],
      },
    },
  });
  assert.equal(images.length, 1);
  assert.equal(images[0].path, '/tmp/one.png');
  assert.equal(images[0].name, 'one.png');
  assert.equal(images[0].mime, 'image/png');
});

test('imagesFromPart reads image tool inputs relative to the session dir', () => {
  const images = imagesFromPart(
    { tool: 'experimental_image_generate', state: { input: { path: 'out/pic.png' } } },
    { dir: '/work/project' },
  );
  assert.equal(images.length, 1);
  assert.equal(images[0].path, join('/work/project', 'out/pic.png'));
  assert.equal(images[0].mime, 'image/png');
});

test('imagesFromPart ignores non-image tool inputs and tool output', () => {
  const images = imagesFromPart({
    tool: 'read',
    state: { input: { path: 'src/app.js' }, output: 'ok' },
  });
  assert.deepEqual(images, []);
});

test('markdown and HTML image targets are extracted and deduped', () => {
  const images = imagesFromPart(
    {
      text: [
        '![shot](<my shot.png>)',
        '![alt](https://example.com/a.jpg "title")',
        '![again](<my shot.png>)',
        '<img src="/tmp/z.gif" />',
      ].join('\n'),
    },
    { dir: '/work' },
  );
  assert.equal(images.length, 3);
  assert.equal(images.find((image) => image.name === 'my shot.png').path, '/work/my shot.png');
  const url = images.find((image) => image.url);
  assert.equal(url.url, 'https://example.com/a.jpg');
  assert.equal(url.mime, 'image/jpeg');
  assert.equal(images.find((image) => image.path === '/tmp/z.gif').mime, 'image/gif');
});

test('imagesFromPart tolerates malformed input and cycles', () => {
  assert.deepEqual(imagesFromPart(null), []);
  assert.deepEqual(imagesFromPart({ text: '![broken](', state: 42 }), []);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() => imagesFromPart({ state: cyclic }));
});

test('openExternalCommand returns the platform opener without a shell', () => {
  assert.deepEqual(openExternalCommand('/tmp/a.png', 'darwin'), {
    command: 'open',
    args: ['/tmp/a.png'],
  });
  assert.deepEqual(openExternalCommand('https://example.com/a.png', 'linux'), {
    command: 'xdg-open',
    args: ['https://example.com/a.png'],
  });
  assert.deepEqual(openExternalCommand('/tmp/a.png', 'win32'), {
    command: 'cmd',
    args: ['/c', 'start', '', '/tmp/a.png'],
  });
});
