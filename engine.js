import {loadLiteRt, loadAndCompile, Tensor} from './vision/litert.js';
import {labels as objectLabels} from './models/labels.js';

const url = path => new URL(path, import.meta.url).href;
const portraitLabels = ['Background', 'Hair', 'Skin / Body (Visible)', 'Face', 'Clothing', 'Accessories'];
const compiled = new Map();
let runtime, anchors;

async function run(kind, pixels, size, channels) {
  runtime ??= loadLiteRt(url('vision/wasm/'));
  await runtime;
  if (!compiled.has(kind)) {
    const model = await loadAndCompile(url('models/' + kind + '.tflite'), {accelerator: 'wasm'});
    compiled.set(kind, model);
  }
  const input = new Tensor(pixels, [1, size, size, channels]);
  let outputs = [];
  try {
    outputs = await compiled.get(kind).run(input);
    return outputs.map(tensor => tensor.toTypedArray().slice());
  } finally {
    input.delete();
    for (const tensor of outputs) tensor.delete();
  }
}

function readPixels(image, size, placement = {x: 0, y: 0, w: size, h: size}) {
  const sample = document.createElement('canvas');
  sample.width = sample.height = size;
  const context = sample.getContext('2d');
  context.drawImage(image, placement.x, placement.y, placement.w, placement.h);
  return context.getImageData(0, 0, size, size).data;
}

function resizeMask(source, size, width, height) {
  const output = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y * size / height) * size;
    for (let x = 0; x < width; x++) {
      output[y * width + x] = source[row + Math.floor(x * size / width)];
    }
  }
  return output;
}

async function portraitMask(image) {
  const size = 256;
  const rgb = readPixels(image, size);
  const pixels = new Float32Array(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 3; c++) pixels[3 * i + c] = (rgb[4 * i + c] - 127.5) / 127.5;
  }
  const [values] = await run('portrait', pixels, size, 3);
  const mask = new Uint8Array(size * size);
  for (let i = 0; i < mask.length; i++) {
    let label = 0;
    for (let c = 1; c < 6; c++) if (values[i * 6 + c] > values[i * 6 + label]) label = c;
    mask[i] = label;
  }
  return resizeMask(mask, size, image.width, image.height);
}

export async function extractAt(image, x, y) {
  const size = 512;
  const rgb = readPixels(image, size);
  const pixels = new Float32Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 3; c++) pixels[4 * i + c] = rgb[4 * i + c] / 255;
  }
  const px = Math.min(size - 1, Math.max(0, Math.floor(x * size)));
  const py = Math.min(size - 1, Math.max(0, Math.floor(y * size)));
  pixels[4 * (py * size + px) + 3] = 1;
  const [values] = await run('touch', pixels, size, 4);
  const mask = Uint8Array.from(values, value => value >= 0.5 ? 1 : 0);
  return resizeMask(mask, size, image.width, image.height);
}

function intersection(a, b) {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const shared = w * h;
  return shared / (a.area + b.area - shared);
}

async function detect(image) {
  const size = 320;
  const fit = size / Math.max(image.width, image.height);
  const w = image.width * fit;
  const h = image.height * fit;
  const padX = (size - w) / 2;
  const padY = (size - h) / 2;
  const rgb = readPixels(image, size, {x: padX, y: padY, w, h});
  const pixels = new Uint8Array(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 3; c++) pixels[3 * i + c] = rgb[4 * i + c];
  }
  if (!anchors) {
    const response = await fetch(url('models/anchors.bin'));
    if (!response.ok) throw new Error('Could not read the detector anchors.');
    anchors = new Float32Array(await response.arrayBuffer());
  }
  const [scores, boxes] = await run('objects', pixels, size, 3);
  if (boxes.length !== anchors.length || scores.length !== boxes.length / 4 * objectLabels.length) {
    throw new Error('The detector output does not match its metadata.');
  }
  const candidates = [];
  for (let i = 0; i < boxes.length / 4; i++) {
    const offset = i * objectLabels.length;
    let category = -1;
    let score = .38;
    for (let c = 0; c < objectLabels.length; c++) {
      if (scores[offset + c] > score && objectLabels[c] !== '???') {
        category = c;
        score = scores[offset + c];
      }
    }
    if (category < 0) continue;
    // EfficientDet-Lite0 metadata specifies YXHW with unit scales,
    // exponential size offsets, and scores that are already probabilities.
    const [ax, ay, aw, ah] = anchors.subarray(4 * i, 4 * i + 4);
    const [dy, dx, dh, dw] = boxes.subarray(4 * i, 4 * i + 4);
    const x = ax + dx * aw;
    const y = ay + dy * ah;
    const w = aw * Math.exp(dw);
    const h = ah * Math.exp(dh);
    const left = Math.max(0, Math.floor(((x - w / 2) * size - padX) / fit));
    const top = Math.max(0, Math.floor(((y - h / 2) * size - padY) / fit));
    const right = Math.min(image.width, Math.ceil(((x + w / 2) * size - padX) / fit));
    const bottom = Math.min(image.height, Math.ceil(((y + h / 2) * size - padY) / fit));
    if (right <= left || bottom <= top) continue;
    candidates.push({label: objectLabels[category], score, left, top, right, bottom,
      area: (right - left) * (bottom - top)});
  }
  candidates.sort((a, b) => b.score - a.score);
  const distinct = [];
  for (const candidate of candidates) {
    if (distinct.some(other => intersection(other, candidate) > .45)) continue;
    distinct.push(candidate);
    if (distinct.length === 8) break;
  }
  return distinct.map(({label, score, left, top, right, bottom}) => ({
    label, score, boundingBox: {originX: left, originY: top, width: right - left, height: bottom - top}
  }));
}

const yieldFrame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

export async function separate(image, progress) {
  const {width, height} = image;
  const claimed = new Uint8Array(width * height);
  const output = [];
  const errors = [];
  let hasPerson = false;
  function claim(name, predicate, min = 1, kind) {
    const mask = new Uint8Array(claimed.length);
    let area = 0;
    for (let i = 0; i < claimed.length; i++) {
      if (!claimed[i] && predicate(i)) {
        mask[i] = 1;
        area++;
      }
    }
    if (area < min) return;
    for (let i = 0; i < claimed.length; i++) claimed[i] |= mask[i];
    output.push({name, mask, kind});
  }

  let detections = [];
  try {
    progress('Finding objects on this device…');
    await yieldFrame();
    detections = await detect(image);
  } catch (error) {
    errors.push('Object detection unavailable');
    console.error(error);
  }

  try {
    progress('Separating hair, skin and clothing…');
    await yieldFrame();
    // The portrait model is trained for people. Use detections to avoid
    // treating animal fur or other textures as portrait categories.
    const people = detections.filter(d => d.label === 'person');
    hasPerson = people.length > 0;
    const portraitBoxes = people.length ? people.map(d => {
      const box = d.boundingBox;
      const margin = Math.round(Math.max(box.width, box.height) * 0.10);
      const x = Math.max(0, box.originX - margin);
      const y = Math.max(0, box.originY - margin);
      const right = Math.min(width, box.originX + box.width + margin);
      const bottom = Math.min(height, box.originY + box.height + margin);
      return {x, y, width: right - x, height: bottom - y};
    }) : errors.length || !detections.length ? [{x: 0, y: 0, width, height}] : [];

    for (const [index, box] of portraitBoxes.entries()) {
      if (box.width <= 0 || box.height <= 0) continue;
      const crop = document.createElement('canvas');
      crop.width = box.width;
      crop.height = box.height;
      crop.getContext('2d').drawImage(image, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
      const labels = await portraitMask(crop);
      if (!people.length) {
        let faceArea = 0;
        for (const label of labels) faceArea += Number(label === 3);
        if (faceArea < labels.length * .003) continue;
      }
      hasPerson = true;
      for (const label of [1, 3, 2, 4, 5]) {
        const suffix = portraitBoxes.length > 1 ? ' · Person ' + (index + 1) : '';
        claim(portraitLabels[label] + suffix, i => {
          const x = (i % width) - box.x;
          const y = Math.floor(i / width) - box.y;
          return x >= 0 && x < box.width && y >= 0 && y < box.height && labels[y * box.width + x] === label;
        }, 10, 'portrait');
      }
      await yieldFrame();
    }
  } catch (error) {
    errors.push('Portrait segmentation unavailable');
    console.error(error);
  }

  const names = new Map();
  for (const detection of detections) {
    const label = detection.label;
    if (!label) continue;
    const box = detection.boundingBox;
    const x = Math.max(0, Math.min(0.999, (box.originX + box.width / 2) / width));
    const y = Math.max(0, Math.min(0.999, (box.originY + box.height / 2) / height));
    if (label === 'person' && claimed[Math.floor(y * height) * width + Math.floor(x * width)]) continue;
    try {
      progress('Extracting a foreground object…');
      await yieldFrame();
      const mask = await extractAt(image, x, y);
      const padding = Math.max(box.width, box.height) * 0.12;
      const displayLabel = label === 'person' ? 'person' : 'foreground object';
      const number = (names.get(displayLabel) || 0) + 1;
      const name = displayLabel[0].toUpperCase() + displayLabel.slice(1) + (number > 1 ? ' ' + number : '');
      const before = output.length;
      const inside = i => {
        if (mask[i] !== 1) return false;
        const px = i % width;
        const py = Math.floor(i / width);
        return px >= box.originX - padding && px <= box.originX + box.width + padding &&
          py >= box.originY - padding && py <= box.originY + box.height + padding;
      };
      let included = 0;
      let duplicate = 0;
      for (let i = 0; i < mask.length; i++) {
        if (!inside(i)) continue;
        included++;
        duplicate += claimed[i];
      }
      if (included && duplicate / included < .55) {
        claim(name, inside, Math.max(20, box.width * box.height * 0.04), label === 'person' ? 'portrait' : 'object');
      }
      if (output.length > before) names.set(displayLabel, number);
    } catch (error) {
      errors.push('Object mask extraction unavailable');
      console.error(error);
      break;
    }
  }
  if (output.length) {
    claim('Background', () => true, 1, 'background');
    return {layers: output.reverse(), errors, hasPerson};
  }
  return {layers: [], errors, hasPerson};
}
