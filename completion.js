const canvas = (width, height) => Object.assign(document.createElement('canvas'), {width, height});

function hull(points) {
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = list => {
    const edge = [];
    for (const p of list) {
      while (edge.length > 1 && cross(edge.at(-2), edge.at(-1), p) <= 0) edge.pop();
      edge.push(p);
    }
    return edge.slice(0, -1);
  };
  return [...half(points), ...half(points.reverse())];
}

export function makePlan(mask, shape, box, cover) {
  if (cover) {
    const visible = canvas(mask.width, mask.height);
    const context = visible.getContext('2d');
    context.drawImage(mask, 0, 0);
    context.globalCompositeOperation = 'destination-out';
    context.fillRect(cover.x, cover.y, cover.w, cover.h);
    mask = visible;
  }
  const {width, height} = mask;
  let alpha = mask.getContext('2d').getImageData(0, 0, width, height).data;
  const points = [];
  let left = width, top = height, right = 0, bottom = 0, known = 0;
  for (let y = 0; y < height; y++) {
    let first = width, last = -1;
    for (let x = 0; x < width; x++) {
      if (alpha[(y * width + x) * 4 + 3] < 128) continue;
      first = Math.min(first, x);
      last = x;
      known++;
    }
    if (last < 0) continue;
    points.push([first, y], [last + 1, y], [first, y + 1], [last + 1, y + 1]);
    left = Math.min(left, first);
    right = Math.max(right, last + 1);
    top = Math.min(top, y);
    bottom = y + 1;
  }
  if (known < 16) throw new Error('Choose a layer with more visible pixels.');
  const outline = canvas(width, height);
  const out = outline.getContext('2d');
  let target;
  if (shape === 'auto') {
    const contour = hull(points);
    out.beginPath();
    out.moveTo(...contour[0]);
    for (const p of contour.slice(1)) out.lineTo(...p);
    out.closePath();
    out.fill();
  } else {
    const {x, y, w, h} = box || {x: left, y: top, w: right - left, h: bottom - top};
    target = {x, y, w, h, shape};
    if (shape === 'round') {
      out.beginPath();
      out.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 2 * Math.PI);
      out.fill();
    } else {
      out.fillRect(x, y, w, h);
    }
  }

  if (box && target) {
    const visible = canvas(width, height);
    const context = visible.getContext('2d');
    context.drawImage(mask, 0, 0);
    context.globalCompositeOperation = 'destination-in';
    context.drawImage(outline, 0, 0);
    mask = visible;
    alpha = context.getImageData(0, 0, width, height).data;
    left = Math.max(0, Math.floor(target.x));
    top = Math.max(0, Math.floor(target.y));
    right = Math.min(width, Math.ceil(target.x + target.w));
    bottom = Math.min(height, Math.ceil(target.y + target.h));
  }
  const shapePixels = out.getImageData(0, 0, width, height).data;
  const missing = canvas(width, height);
  const mc = missing.getContext('2d');
  const tint = mc.createImageData(width, height);
  let count = 0, overlap = 0;
  for (let i = 0; i < alpha.length; i += 4) {
    if (shapePixels[i + 3] < 128) continue;
    if (alpha[i + 3] > 0) {
      if (alpha[i + 3] >= 128) overlap++;
      continue;
    }
    count++;
    tint.data[i] = 255;
    tint.data[i + 1] = 191;
    tint.data[i + 2] = 76;
    tint.data[i + 3] = 155;
    const x = (i / 4) % width, y = Math.floor(i / 4 / width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + 1);
    bottom = Math.max(bottom, y + 1);
  }
  if (overlap < 16 || count > overlap * 3) {
    throw new Error('The outline needs more visible material for a useful estimate. Draw a tighter outline over the part.');
  }
  mc.putImageData(tint, 0, 0);
  return {missing, count, mask, cover, target, clipTarget: box ? target : null, bounds: {left, top, right, bottom}};
}

function reflectIfSupported(pixels, visible, holes, target, width) {
  const axis = Math.round(target.x * 2 + target.w - 1);
  let samples = 0, difference = 0;
  for (let i = 0; i < visible.length; i += 16) {
    if (visible[i + 3] < 240) continue;
    const x = (i / 4) % width, opposite = axis - x;
    if (opposite < 0 || opposite >= width) continue;
    const j = i + (opposite - x) * 4;
    if (visible[j + 3] < 240) continue;
    for (let channel = 0; channel < 3; channel++) difference += Math.abs(pixels[i + channel] - pixels[j + channel]);
    samples++;
  }
  if (samples < 40 || difference / (samples * 3) > 16) return null;

  const reflections = new Int32Array(visible.length / 4).fill(-1);
  let matched = 0;
  for (let i = 0; i < reflections.length; i++) {
    if (!holes[i * 4 + 3]) continue;
    const x = i % width, opposite = axis - x;
    if (opposite < 0 || opposite >= width) continue;
    const j = i + opposite - x;
    if (visible[j * 4 + 3] < 240) continue;
    reflections[i] = j * 4;
    matched++;
  }
  return matched ? reflections : null;
}

export async function completeLayer(source, plan, useSymmetry, onStatus) {
  const {width, height} = source;
  const {left, top, right, bottom} = plan.bounds;
  const padding = Math.max(5, Math.round(Math.max(right - left, bottom - top) * .06));
  const side = Math.max(right - left, bottom - top) + padding * 2;
  const x = Math.round((left + right - side) / 2);
  const y = Math.round((top + bottom - side) / 2);
  const size = 512;

  const sourceData = source.getContext('2d').getImageData(0, 0, width, height).data;
  const visible = plan.mask.getContext('2d').getImageData(0, 0, width, height).data;
  let red = 0, green = 0, blue = 0, count = 0;
  for (let i = 0; i < visible.length; i += 4) {
    if (visible[i + 3] < 240) continue;
    red += sourceData[i];
    green += sourceData[i + 1];
    blue += sourceData[i + 2];
    count++;
  }
  if (!count) throw new Error('There are too few fully visible pixels in this outline.');
  const matte = 'rgb(' + [red, green, blue].map(value => Math.round(value / count)).join(',') + ')';
  const contextImage = canvas(width, height);
  const input = contextImage.getContext('2d');
  input.drawImage(source, 0, 0);
  input.globalCompositeOperation = 'destination-in';
  input.drawImage(plan.mask, 0, 0);
  input.globalCompositeOperation = 'destination-over';
  input.fillStyle = matte;
  input.fillRect(0, 0, width, height);

  const sample = canvas(size, size);
  const sampleContext = sample.getContext('2d');
  const scale = size / side;
  sampleContext.fillStyle = matte;
  sampleContext.fillRect(0, 0, size, size);
  sampleContext.drawImage(contextImage, -x * scale, -y * scale, width * scale, height * scale);
  const rgb = sampleContext.getImageData(0, 0, size, size).data;
  sampleContext.clearRect(0, 0, size, size);
  sampleContext.imageSmoothingEnabled = false;
  sampleContext.drawImage(plan.missing, -x * scale, -y * scale, width * scale, height * scale);
  const holes = sampleContext.getImageData(0, 0, size, size).data;

  const worker = new Worker(new URL('./completion-worker.js', import.meta.url), {type: 'module'});
  try {
    const pixels = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('AI fill timed out on this device. Try a faster browser or computer.')), 180000);
      const finish = callback => value => {
        clearTimeout(timer);
        callback(value);
      };
      worker.onerror = finish(() => reject(new Error('The browser could not start the AI fill worker.')));
      worker.onmessage = ({data}) => {
        if (data.status) onStatus(data.status);
        else if (data.error) finish(reject)(new Error(data.error));
        else finish(resolve)(data.pixels);
      };
      worker.postMessage({rgb, holes}, [rgb.buffer, holes.buffer]);
    });
    sampleContext.putImageData(new ImageData(pixels, size, size), 0, 0);
  } finally {
    worker.terminate();
  }

  const generated = canvas(width, height);
  const fill = generated.getContext('2d');
  fill.drawImage(sample, x, y, side, side);
  const holeData = plan.missing.getContext('2d').getImageData(0, 0, width, height);
  const reflections = useSymmetry && plan.target ?
    reflectIfSupported(sourceData, visible, holeData.data, plan.target, width) : null;
  if (reflections) {
    const result = fill.getImageData(0, 0, width, height);
    for (let i = 0; i < reflections.length; i++) {
      const reflected = reflections[i];
      if (reflected < 0) continue;
      for (let channel = 0; channel < 3; channel++) {
        const target = i * 4 + channel;
        result.data[target] = result.data[target] * .06 + sourceData[reflected + channel] * .94;
      }
    }
    fill.putImageData(result, 0, 0);
  }
  for (let i = 3; i < holeData.data.length; i += 4) {
    holeData.data[i] = holeData.data[i] ? 255 : 0;
  }
  const clip = canvas(width, height);
  clip.getContext('2d').putImageData(holeData, 0, 0);
  fill.globalCompositeOperation = 'destination-in';
  fill.drawImage(clip, 0, 0);
  return {generated, symmetryUsed: Boolean(reflections)};
}
