import {extractAt, separate} from './engine.js';
import {makePlan, completeLayer} from './completion.js';
import {zipSync, strToU8} from './zip.js';
import {isPlain, prepareSource, renderStyle, styleFor} from './styles.js';

const $ = id => document.getElementById(id);
const view = $('view');
const ctx = view.getContext('2d');
const sourceView = $('sourceView');
const thumbnailSize = 320;
let edgeRefine = 0;
let objectPhoto = false;
let photo, working, filename, originalFile, selected, layout, gesture, sourcePixels, sourcePreview;
let layers = [];
let mode = 'move';
let exploded = false;
let autoSegmented = false;
let viewMode = 'normal';
let styleTarget = 'all';
let globalStyle = styleFor('normal');
let isolated = false;
let zoom = 1;
let spreadFactor = 0;
let transitionFrame;
let renderFrame;
let pinch;
const touches = new Map();
const styleFields = ['intensity', 'detail', 'contrast', 'brightness', 'material'];
let busy = false;
let offlineWorker;
let draft;
let outlineBox, coverBox;
const filterToggle = $('nsfwFilter');
const filterOff = $('nsfwOff');
const filterPreference = 'layerpeel-block-nsfw';
try {
  if (localStorage.getItem(filterPreference) === 'false') filterOff.checked = true;
} catch {
  // The checkbox still applies for this session.
}
filterToggle.onchange = filterOff.onchange = () => {
  try {
    localStorage.setItem(filterPreference, String(filterToggle.checked));
  } catch {
    // The checkbox still applies for this session.
  }
  status(filterToggle.checked ? 'NSFW filter on for new photos.' : 'NSFW filter off for new photos.');
};

function canvas(w, h) {
  const element = document.createElement('canvas');
  element.width = w;
  element.height = h;
  return element;
}

function status(message, error = false) {
  $('status').classList.toggle('error', error);
  $('status').querySelector('span').textContent = message;
}

function setBusy(value) {
  busy = value;
  syncControls();
}

function syncControls() {
  for (const id of ['open', 'choose', 'nsfwFilter', 'nsfwOff']) $(id).disabled = busy;
  for (const id of ['add', 'tap', 'reset', 'viewPng', 'original']) $(id).disabled = busy || !photo;
  for (const button of document.querySelectorAll('[data-view]')) button.disabled = busy;
  $('segment').disabled = busy || !photo || autoSegmented;
  $('segment').textContent = autoSegmented ? '✓ Layers separated' : '✦ Separate layers';
  $('styling').disabled = busy || !photo;
  $('styleTarget').options[1].disabled = !selected;
  $('preset').options[0].hidden = styleTarget !== 'layer';
  $('preset').querySelector('[value=isolate]').disabled = !selected;
  $('isolate').setAttribute('aria-pressed', String(isolated));
  $('raise').disabled = !selected || layers.indexOf(selected) === layers.length - 1;
  $('lower').disabled = !selected || layers.indexOf(selected) === 0;
  $('zoom').disabled = !photo;
  $('properties').disabled = busy || !selected;
  $('undo').disabled = busy || !selected?.history.length;
  $('zip').disabled = busy || !layers.length;
  $('png').disabled = busy || !selected;
  $('spacing').disabled = !exploded || layers.length < 2;
  $('quickControls').disabled = busy || !photo;
  $('quickOpacity').disabled = !selected;
  $('refine').disabled = !layers.length;
  $('completion').disabled = busy || !canComplete(selected);
  for (const id of ['saveFill', 'clearFill']) $(id).disabled = !selected?.fill;
  $('clearCover').disabled = !coverBox;
  $('fillHelp').textContent = selected?.fill ?
    'AI fill is stored separately. Selected PNG still exports source pixels only.' :
    canComplete(selected) ? 'Preview or draw the object’s full outline before generating.' :
      'AI fill is available for object layers in photos without detected people.';
}

function canComplete(layer) {
  return objectPhoto && ['object', 'tap'].includes(layer?.kind);
}

function createLayer(name, data, method, kind) {
  const mask = canvas(working.width, working.height);
  if (data) {
    const mc = mask.getContext('2d');
    const pixels = mc.createImageData(mask.width, mask.height);
    for (let i = 0; i < data.length; i++) pixels.data[4 * i + 3] = data[i] ? 255 : 0;
    mc.putImageData(pixels, 0, 0);
  }
  const layer = {name, method, kind, region: name, style: null, mask,
    preview: canvas(mask.width, mask.height),
    x: 0, y: 0, rotation: 0, opacity: 1, visible: true, history: []};
  refreshLayer(layer);
  return layer;
}

function invalidateMask(layer) {
  layer.maskVersion = (layer.maskVersion || 0) + 1;
  refreshLayer(layer);
  updateThumbnails(layer);
}

function maskOutline(layer) {
  if (layer.contourVersion === layer.maskVersion && layer.contour) return layer.contour;
  const {width, height} = layer.mask;
  const {data} = layer.mask.getContext('2d').getImageData(0, 0, width, height);
  const contour = layer.contour || canvas(width, height);
  const outline = contour.getContext('2d');
  const pixels = outline.createImageData(width, height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const j = (y * width + x) * 4;
      if (data[j + 3] < 128) continue;
      if (data[j - 1] < 128 || data[j + 7] < 128 ||
          data[j - width * 4 + 3] < 128 || data[j + width * 4 + 3] < 128) {
        pixels.data[j] = pixels.data[j + 1] = pixels.data[j + 2] = 255;
        pixels.data[j + 3] = 230;
      }
    }
  }
  outline.putImageData(pixels, 0, 0);
  layer.contour = contour;
  layer.contourVersion = layer.maskVersion;
  return contour;
}

function updateThumbnails(layer) {
  if (!layer.thumbnails?.length) return;
  if (layer.thumbVersion !== layer.maskVersion || !layer.thumb) {
    const {width, height} = layer.mask;
    const {data} = layer.mask.getContext('2d').getImageData(0, 0, width, height);
    let left = width, top = height, right = 0, bottom = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!data[(y * width + x) * 4 + 3]) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + 1);
        bottom = y + 1;
      }
    }
    layer.thumb = canvas(thumbnailSize, thumbnailSize);
    if (right > left) {
      const w = right - left, h = bottom - top;
      const scale = (thumbnailSize - 24) / Math.max(w, h);
      const bounds = [(thumbnailSize - w * scale) / 2, (thumbnailSize - h * scale) / 2, w * scale, h * scale];
      const context = layer.thumb.getContext('2d');
      context.drawImage(working, left, top, w, h, ...bounds);
      context.globalCompositeOperation = 'destination-in';
      context.drawImage(layer.mask, left, top, w, h, ...bounds);
    }
    layer.thumbVersion = layer.maskVersion;
  }
  for (const thumbnail of layer.thumbnails) {
    const context = thumbnail.getContext('2d');
    context.clearRect(0, 0, thumbnail.width, thumbnail.height);
    context.drawImage(layer.thumb, 0, 0, thumbnail.width, thumbnail.height);
  }
}

function refreshLayer(layer) {
  const p = layer.preview.getContext('2d');
  const style = layer.style || globalStyle;
  p.clearRect(0, 0, layer.preview.width, layer.preview.height);
  if (isPlain(style)) p.drawImage(working, 0, 0);
  else renderStyle(p, sourcePixels, style, layer.region);
  layer.lastStyle = style;
  layer.lastRefine = edgeRefine;
  p.globalCompositeOperation = 'destination-in';
  if (edgeRefine) p.filter = 'blur(' + edgeRefine / 45 + 'px)';
  p.drawImage(layer.mask, 0, 0);
  p.filter = 'none';
  p.globalCompositeOperation = 'source-over';
}

function renderList() {
  const list = $('layers');
  const gallery = $('gallery');
  list.replaceChildren();
  gallery.replaceChildren();
  $('count').textContent = layers.length;
  if (!layers.length) {
    const hint = document.createElement('p');
    hint.className = 'placeholder';
    hint.textContent = photo ? 'Separate the photo or create a manual layer.' : 'Your extracted layers will appear here.';
    list.append(hint);
    const emptyGallery = hint.cloneNode();
    emptyGallery.textContent = 'Separate a photo to see its individual cutouts.';
    gallery.append(emptyGallery);
  }
  for (const layer of [...layers].reverse()) {
    const row = document.createElement('div');
    row.className = 'layer-row' + (selected === layer ? ' active' : '');
    const label = document.createElement('button');
    label.className = 'layer-label';
    const text = document.createElement('span');
    text.textContent = layer.name;
    label.title = layer.name;
    label.setAttribute('aria-pressed', String(selected === layer));
    const detail = document.createElement('small');
    detail.textContent = layer.fill ? 'PNG · AI fill available' : 'PNG · Alpha';
    text.append(detail);
    const thumbnail = canvas(72, 72);
    thumbnail.setAttribute('aria-hidden', 'true');
    label.append(thumbnail, text);
    label.onclick = () => select(layer);
    const eye = document.createElement('button');
    eye.className = 'eye';
    eye.innerHTML = '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/><path class="eye-slash" d="M3 3l18 18"/></svg>';
    const syncEye = () => {
      eye.dataset.visible = String(layer.visible);
      eye.setAttribute('aria-label', (layer.visible ? 'Hide ' : 'Show ') + layer.name);
    };
    syncEye();
    eye.onclick = () => {
      layer.visible = !layer.visible;
      syncEye();
      draw();
    };
    row.append(eye, label);
    list.append(row);

    const tile = document.createElement('button');
    tile.className = 'gallery-tile';
    tile.setAttribute('aria-pressed', String(selected === layer));
    tile.setAttribute('aria-label', 'Select ' + layer.name);
    tile.onclick = () => select(layer);
    const large = canvas(thumbnailSize, thumbnailSize);
    large.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span');
    title.textContent = layer.name + '.png';
    tile.append(large, title);
    gallery.append(tile);
    layer.thumbnails = [thumbnail, large];
    updateThumbnails(layer);
  }
}

function select(layer) {
  if (selected !== layer) {
    draft = outlineBox = coverBox = null;
    if (['outline', 'cover'].includes(mode)) setMode('move');
  }
  selected = layer;
  if (!layer) {
    isolated = false;
    styleTarget = 'all';
  }
  syncStyleControls();
  $('selection').textContent = layer?.name || 'No selection';
  $('name').value = layer?.name || '';
  syncOpacity();
  for (const key of ['x', 'y', 'rotation']) $(key).value = layer?.[key] ?? '';
  renderList();
  syncControls();
  draw();
}

function setMode(next) {
  mode = next;
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
  $('tap').setAttribute('aria-pressed', String(mode === 'tap'));
  view.classList.toggle('mark', mode !== 'move');
  $('drawOutline').setAttribute('aria-pressed', String(mode === 'outline'));
  $('drawCover').setAttribute('aria-pressed', String(mode === 'cover'));
  $('toolHelp').textContent = ({
    move: 'Select a layer, then drag it or set X and Y.',
    keep: 'Brush over the preview to restore source pixels to this layer.',
    erase: 'Brush over the preview to remove pixels from this layer.',
    tap: 'Tap a visible part of the original photo to extract a new object layer.',
    outline: 'Drag from one corner of the complete part to the opposite corner.',
    cover: 'Drag a rectangle around the piece that covers the target.'
  })[mode];
  draw();
}

function setView(value) {
  exploded = value;
  $('exploded').setAttribute('aria-pressed', String(value));
  $('composite').setAttribute('aria-pressed', String(!value));
  syncControls();
  cancelAnimationFrame(transitionFrame);
  const from = spreadFactor;
  const target = value ? 1 : 0;
  if (from === target || !photo || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    spreadFactor = target;
    draw();
    return;
  }
  const start = performance.now();
  const animate = now => {
    const progress = Math.min(1, (now - start) / 180);
    spreadFactor = from + (target - from) * (1 - (1 - progress) ** 2);
    draw();
    if (progress < 1) transitionFrame = requestAnimationFrame(animate);
  };
  transitionFrame = requestAnimationFrame(animate);
}

function syncStyleControls() {
  $('styleTarget').value = styleTarget;
  const individual = styleTarget === 'layer' && selected;
  const style = (individual && selected.style) || globalStyle;
  $('quickContrast').value = style.contrast;
  $('quickContrastValue').value = style.contrast + '%';
  $('materialMap').value = [0, 55, 86].includes(style.material) ? String(style.material) : 'custom';
  $('preset').options[0].hidden = !individual;
  $('preset').value = isolated && !individual ? 'isolate' : individual && !selected.style ? 'inherit' : style.preset;
  $('inherit').hidden = !individual || !selected.style;
  for (const field of styleFields) {
    $(field).value = style[field];
    $(field + 'Value').value = style[field] + (['intensity', 'detail', 'material'].includes(field) ? '%' : '');
  }
}

function updateStageTag() {
  const styled = mode !== 'tap' && (!isPlain(globalStyle) || layers.some(layer => layer.style && !isPlain(layer.style)));
  const generated = mode !== 'tap' && $('showFill').checked &&
    layers.some(layer => layer.fill && layer.visible && (!isolated || layer === selected));
  $('stageTag').lastChild.textContent = generated ? ' SOURCE + AI ESTIMATE' :
    styled ? ' STYLED SOURCE PIXELS' : ' SOURCE PIXELS';
}

function setWorkspaceMode(next, runInference = true) {
  viewMode = next;
  for (const button of document.querySelectorAll('[data-view]')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === next));
  }
  isolated = false;
  styleTarget = 'all';
  globalStyle = styleFor(({material: 'material', xray: 'xray'})[next] || 'normal');
  if (next === 'peel') globalStyle.material = 55;
  if (mode === 'tap') setMode('move');
  setView(false);
  syncStyleControls();
  draw();
  if (next !== 'normal' && runInference && photo && !autoSegmented && !busy) void segmentPhoto(false);
}

function queueDraw() {
  if (!renderFrame) renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    draw();
  });
}

function draw(showGuides = true) {
  if (!photo) return;
  updateStageTag();
  const w = view.clientWidth;
  const h = view.clientHeight;
  if (!w || !h) return;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const rw = Math.round(w * ratio);
  const rh = Math.round(h * ratio);
  if (view.width !== rw || view.height !== rh) {
    view.width = rw;
    view.height = rh;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const stack = mode !== 'tap' && spreadFactor > 0 && layers.length > 1 && !isolated;
  const spread = stack ? spreadFactor * Number($('spacing').value) / 100 : 0;
  const dx = spread * w * .40;
  const dy = spread * h * .43;
  const scale = zoom * Math.min((w - dx - 28) / working.width, (h - dy - 28) / working.height);
  layout = {w, h, dx, dy, scale};
  if (sourceView.width !== rw || sourceView.height !== rh || sourceView.photo !== working) {
    sourceView.width = rw;
    sourceView.height = rh;
    sourceView.photo = working;
    const source = sourceView.getContext('2d');
    const fit = Math.min((w - 28) / working.width, (h - 28) / working.height);
    source.setTransform(ratio, 0, 0, ratio, 0, 0);
    source.drawImage(working, (w - working.width * fit) / 2, (h - working.height * fit) / 2,
      working.width * fit, working.height * fit);
  }
  if (!layers.length || mode === 'tap') {
    let image = working;
    if (mode !== 'tap' && !isPlain(globalStyle)) {
      if (sourcePreview.lastStyle !== globalStyle) {
        renderStyle(sourcePreview.getContext('2d'), sourcePixels, globalStyle, 'subject');
        sourcePreview.lastStyle = globalStyle;
      }
      image = sourcePreview;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image, (w - working.width * scale) / 2, (h - working.height * scale) / 2,
      working.width * scale, working.height * scale);
    return;
  }
  for (const [index, layer] of layers.entries()) {
    if (!layer.visible || isolated && layer !== selected) continue;
    if (layer.lastStyle !== (layer.style || globalStyle) || layer.lastRefine !== edgeRefine) refreshLayer(layer);
    const p = placement(layer, index);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(layer.rotation * Math.PI / 180);
    ctx.scale(scale, scale);
    if (stack && showGuides) {
      ctx.strokeStyle = layer === selected ? '#80dcff' : '#8cabc880';
      ctx.lineWidth = 1 / scale;
      ctx.strokeRect(-working.width / 2, -working.height / 2, working.width, working.height);
    }
    ctx.globalAlpha = layer.opacity;
    ctx.imageSmoothingEnabled = layer.rotation !== 0;
    const x = -working.width / 2, y = -working.height / 2;
    if (layer.fill && $('showFill').checked) ctx.drawImage(layer.fill, x, y);
    const visiblePlan = showGuides && layer === selected && draft ? draft :
      $('showFill').checked && layer.fillPlan;
    ctx.save();
    if (visiblePlan?.clipTarget) {
      const target = visiblePlan.clipTarget;
      ctx.beginPath();
      if (target.shape === 'round') {
        ctx.ellipse(x + target.x + target.w / 2, y + target.y + target.h / 2, target.w / 2, target.h / 2, 0, 0, 2 * Math.PI);
      } else ctx.rect(x + target.x, y + target.y, target.w, target.h);
      ctx.clip();
    }
    if (visiblePlan?.cover) {
      const cover = visiblePlan.cover;
      ctx.beginPath();
      ctx.rect(x, y, working.width, working.height);
      ctx.rect(x + cover.x, y + cover.y, cover.w, cover.h);
      ctx.clip('evenodd');
    }
    ctx.drawImage(layer.preview, x, y);
    if (layer.kind !== 'background' && (viewMode === 'peel' || viewMode === 'outline')) {
      ctx.drawImage(maskOutline(layer), x, y);
    }
    ctx.restore();
    if (layer.fill && $('showFill').checked && $('markFill').checked) ctx.drawImage(layer.fillMark, x, y);
    if (showGuides && layer === selected) {
      if (draft) ctx.drawImage(draft.missing, x, y);
      if (['outline', 'cover'].includes(gesture?.mode) && gesture.box) {
        const box = gesture.box;
        ctx.strokeStyle = gesture.mode === 'cover' ? '#ff958b' : '#ffbf4c';
        ctx.lineWidth = 2 / scale;
        ctx.beginPath();
        if (gesture.mode === 'outline' && $('shape').value === 'round') {
          ctx.ellipse(x + box.x + box.w / 2, y + box.y + box.h / 2, box.w / 2, box.h / 2, 0, 0, 2 * Math.PI);
        } else ctx.rect(x + box.x, y + box.y, box.w, box.h);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

function placement(layer, index) {
  const {w, h, dx, dy, scale} = layout;
  const offset = layers.length > 1 ? index / (layers.length - 1) - .5 : 0;
  return {
    x: w / 2 + dx * offset + layer.x * scale * working.width / photo.width,
    y: h / 2 - dy * offset + layer.y * scale * working.height / photo.height
  };
}

async function decodePhoto(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // Some browsers can decode additional formats through an image element.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function openFile(file) {
  if (!file || busy) return;
  setBusy(true);
  status('Opening photo…');
  let bitmap;
  try {
    bitmap = await decodePhoto(file);
    if (bitmap.width * bitmap.height > 24000000 || Math.max(bitmap.width, bitmap.height) > 8192) {
      throw new Error('Choose an image up to 24 MP and 8192 pixels per side for full-size export.');
    }
    const scale = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height));
    const next = canvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    next.getContext('2d').drawImage(bitmap, 0, 0, next.width, next.height);
    if (filterToggle.checked) {
      status('Checking photo on this device…');
      try {
        const {shouldBlockPhoto} = await import('./filter.js');
        if (await shouldBlockPhoto(next)) {
          status('Photo blocked by the NSFW filter.', true);
          return;
        }
      } catch (error) {
        console.error('Photo filter could not run.', error);
        status('The NSFW check could not run. Try again or set the NSFW filter to Off.', true);
        return;
      }
    }
    photo?.close?.();
    photo = bitmap;
    bitmap = null;
    working = next;
    sourcePixels = prepareSource(next.getContext('2d'), next.width, next.height);
    sourcePreview = canvas(next.width, next.height);
    originalFile = file;
    autoSegmented = false;
    objectPhoto = false;
    edgeRefine = 0;
    $('refine').value = 0;
    $('refineValue').value = '0%';
    zoom = 1;
    $('zoom').value = 100;
    $('zoomValue').value = '100%';
    filename = file.name.replace(/\.[^.]+$/, '') || 'photo';
    layers = [];
    $('dimensions').textContent = photo.width + ' × ' + photo.height;
    $('empty').hidden = true;
    view.hidden = $('stageTag').hidden = $('sourcePanel').hidden = false;
    setMode('move');
    setWorkspaceMode('normal', false);
    select(null);
    status(file.name + ' loaded. Choose Separate layers to run the local models.');
  } catch (error) {
    status(error instanceof DOMException ? 'Could not open this photo. Try a JPEG, PNG, or WebP.' : error.message, true);
  } finally {
    bitmap?.close?.();
    setBusy(false);
  }
}

for (const id of ['choose', 'open']) {
  $(id).onchange = ({currentTarget}) => {
    const file = currentTarget.files[0];
    currentTarget.value = '';
    void openFile(file);
  };
}
$('stage').ondragover = event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  if (!busy) $('stage').classList.add('drag');
};
$('stage').ondragleave = () => $('stage').classList.remove('drag');
$('stage').ondrop = event => {
  event.preventDefault();
  $('stage').classList.remove('drag');
  void openFile(event.dataTransfer.files[0]);
};
async function segmentPhoto(showPeel) {
  setBusy(true);
  setMode('move');
  try {
    const result = await separate(working, status);
    if (result.layers.length) {
      const extracted = result.layers.map(layer => createLayer(layer.name, layer.mask, 'AI mask · source pixels', layer.kind));
      objectPhoto = !result.errors.length && !result.hasPerson && extracted.some(layer => layer.kind === 'object');
      layers.unshift(...extracted);
      autoSegmented = true;
      select(extracted.at(-1));
      if (showPeel) setWorkspaceMode('peel', false);
      status(extracted.length + ' layers extracted locally.' +
        (result.errors.length ? ' ' + result.errors.join('. ') + '.' : ''), Boolean(result.errors.length));
    } else {
      status(result.errors.length ?
        result.errors.join('. ') + '. Try an updated Chrome browser or use a blank layer and mask brush.' :
        'No confident regions found. Try Tap to extract or add a blank layer.', true);
    }
  } catch (error) {
    status('Could not separate this photo. ' + error.message, true);
  } finally {
    setBusy(false);
  }
}
$('segment').onclick = () => segmentPhoto(true);
for (const button of document.querySelectorAll('[data-view]')) {
  button.onclick = () => setWorkspaceMode(button.dataset.view);
}
$('styleTarget').onchange = () => {
  styleTarget = $('styleTarget').value;
  syncStyleControls();
};
$('preset').onchange = () => {
  const preset = $('preset').value;
  if (preset === 'isolate') {
    if (selected) selected.visible = true;
    isolated = Boolean(selected);
    renderList();
  } else if (styleTarget === 'layer' && selected) {
    selected.style = preset === 'inherit' ? null : styleFor(preset);
  } else {
    globalStyle = styleFor(preset);
    isolated = false;
  }
  syncStyleControls();
  syncControls();
  draw();
};
$('inherit').onclick = () => {
  if (!selected) return;
  selected.style = null;
  syncStyleControls();
  draw();
};
function setStyleField(field, value) {
  const individual = styleTarget === 'layer' && selected;
  const style = {...((individual && selected.style) || globalStyle), [field]: value};
  if (individual) selected.style = style;
  else globalStyle = style;
  syncStyleControls();
  queueDraw();
}
for (const field of styleFields) {
  $(field).oninput = () => setStyleField(field, Number($(field).value));
}
$('quickContrast').oninput = () => setStyleField('contrast', Number($('quickContrast').value));
$('materialMap').onchange = () => setStyleField('material', Number($('materialMap').value));
$('refine').oninput = () => {
  edgeRefine = Number($('refine').value);
  $('refineValue').value = edgeRefine + '%';
  queueDraw();
};
$('isolate').onclick = () => {
  if (!selected) return;
  isolated = !isolated;
  if (isolated) selected.visible = true;
  renderList();
  syncControls();
  syncStyleControls();
  draw();
};
for (const [id, amount] of [['raise', 1], ['lower', -1]]) {
  $(id).onclick = () => {
    const index = layers.indexOf(selected);
    const to = index + amount;
    if (index < 0 || to < 0 || to >= layers.length) return;
    layers.splice(index, 1);
    layers.splice(to, 0, selected);
    select(selected);
  };
}
function setZoom(value) {
  zoom = Math.max(1, Math.min(3, value));
  $('zoom').value = Math.round(zoom * 100);
  $('zoomValue').value = $('zoom').value + '%';
  queueDraw();
}
$('zoom').oninput = () => setZoom(Number($('zoom').value) / 100);
$('reset').onclick = () => {
  for (const layer of layers) {
    layer.x = 0;
    layer.y = 0;
    layer.rotation = 0;
  }
  setZoom(1);
  select(selected);
  status('Layer offsets, rotation, and zoom reset.');
};
$('composite').onclick = () => setView(false);
$('exploded').onclick = () => setView(true);
$('spacing').oninput = () => {
  $('gap').value = $('spacing').value + '%';
  draw();
};
$('add').onclick = () => {
  const layer = createLayer('Manual layer ' + (layers.length + 1), null, 'Manual mask · source pixels');
  layers.push(layer);
  select(layer);
  setMode('keep');
  status('Blank layer added. Brush to reveal pixels from the source photo.');
};
$('tap').onclick = () => setMode(mode === 'tap' ? 'move' : 'tap');
for (const button of document.querySelectorAll('[data-mode]')) {
  button.onclick = () => setMode(button.dataset.mode);
}
$('name').onchange = () => {
  selected.name = $('name').value.trim() || 'Untitled layer';
  select(selected);
};
function syncOpacity() {
  const percent = Math.round((selected?.opacity ?? 1) * 100);
  $('opacity').value = $('quickOpacity').value = percent;
  $('alpha').value = $('quickAlpha').value = percent + '%';
}
for (const id of ['opacity', 'quickOpacity']) {
  $(id).oninput = () => {
    selected.opacity = Number($(id).value) / 100;
    syncOpacity();
    draw();
  };
}
for (const key of ['x', 'y', 'rotation']) $(key).oninput = () => {
  if ($(key).value === '' || !Number.isFinite($(key).valueAsNumber)) return;
  selected[key] = $(key).valueAsNumber;
  draw();
};
$('brush').oninput = () => { $('brushSize').value = $('brush').value; };
$('undo').onclick = () => {
  discardFill(selected);
  selected.mask.getContext('2d').putImageData(selected.history.pop(), 0, 0);
  invalidateMask(selected);
  syncControls();
  draw();
};

function point(event, layer) {
  const rect = view.getBoundingClientRect();
  const p = layer ? placement(layer, layers.indexOf(layer)) : {x: layout.w / 2, y: layout.h / 2};
  const dx = (event.clientX - rect.left - p.x) / layout.scale;
  const dy = (event.clientY - rect.top - p.y) / layout.scale;
  const angle = -(layer?.rotation || 0) * Math.PI / 180;
  return {x: dx * Math.cos(angle) - dy * Math.sin(angle) + working.width / 2,
    y: dx * Math.sin(angle) + dy * Math.cos(angle) + working.height / 2};
}

function paint(layer, from, to, operation) {
  const m = layer.mask.getContext('2d');
  const size = Number($('brush').value) / layout.scale;
  m.globalCompositeOperation = operation === 'erase' ? 'destination-out' : 'source-over';
  m.lineWidth = size;
  m.lineCap = 'round';
  m.beginPath();
  if (from.x === to.x && from.y === to.y) {
    m.arc(to.x, to.y, size / 2, 0, 2 * Math.PI);
    m.fill();
  } else {
    m.moveTo(from.x, from.y);
    m.lineTo(to.x, to.y);
    m.stroke();
  }
  invalidateMask(layer);
  draw();
}

view.onpointerdown = async event => {
  if (!photo || busy || event.button !== 0) return;
  if (event.pointerType === 'touch' && mode !== 'tap') {
    touches.set(event.pointerId, {x: event.clientX, y: event.clientY});
    view.setPointerCapture(event.pointerId);
    if (touches.size === 2) {
      if (['keep', 'erase'].includes(gesture?.mode) && gesture.layer.history.length) {
        const layer = gesture.layer;
        layer.mask.getContext('2d').putImageData(layer.history.pop(), 0, 0);
        invalidateMask(layer);
        syncControls();
        draw();
      }
      gesture = null;
      pinch = {distance: touchDistance(), zoom};
      return;
    }
  }
  if (gesture) return;
  if (mode === 'tap') {
    const p = point(event);
    const x = p.x / working.width;
    const y = p.y / working.height;
    if (x < 0 || y < 0 || x >= 1 || y >= 1) return;
    setBusy(true);
    status('Extracting the tapped object…');
    try {
      const mask = await extractAt(working, x, y);
      if (!mask.some(value => value === 1)) {
        status('No object mask returned. Tap closer to the center or use the brush.', true);
      } else {
        const layer = createLayer('Object selection ' + (layers.length + 1), mask, 'AI tap mask · source pixels', 'tap');
        layers.push(layer);
        select(layer);
        setMode('move');
        status('Object extracted from the source photo.');
      }
    } catch (error) {
      status('Tap extraction failed. ' + error.message, true);
    } finally {
      setBusy(false);
    }
    return;
  }
  if (!selected?.visible) return;
  view.setPointerCapture(event.pointerId);
  gesture = {id: event.pointerId, mode, layer: selected, x: event.clientX, y: event.clientY};
  if (['outline', 'cover'].includes(mode)) {
    gesture.start = point(event, selected);
  } else if (mode !== 'move') {
    discardFill(selected);
    const m = selected.mask.getContext('2d');
    selected.history.push(m.getImageData(0, 0, selected.mask.width, selected.mask.height));
    if (selected.history.length > 5) selected.history.shift();
    gesture.last = point(event, selected);
    paint(selected, gesture.last, gesture.last, mode);
    syncControls();
  }
};
function touchDistance() {
  const [a, b] = touches.values();
  return a && b ? Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) : 1;
}

view.onpointermove = event => {
  if (touches.has(event.pointerId)) touches.set(event.pointerId, {x: event.clientX, y: event.clientY});
  if (pinch && touches.size >= 2) {
    setZoom(pinch.zoom * touchDistance() / pinch.distance);
    return;
  }
  if (gesture?.id !== event.pointerId) return;
  const layer = gesture.layer;
  if (['outline', 'cover'].includes(gesture.mode)) {
    const end = point(event, layer), start = gesture.start;
    gesture.box = {x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
      w: Math.abs(start.x - end.x), h: Math.abs(start.y - end.y)};
    draw();
  } else if (gesture.mode === 'move') {
    layer.x += (event.clientX - gesture.x) * photo.width / (working.width * layout.scale);
    layer.y += (event.clientY - gesture.y) * photo.height / (working.height * layout.scale);
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    $('x').value = Math.round(layer.x);
    $('y').value = Math.round(layer.y);
    draw();
  } else {
    const next = point(event, layer);
    paint(layer, gesture.last, next, gesture.mode);
    gesture.last = next;
  }
};
view.onlostpointercapture = view.onpointercancel = view.onpointerup = event => {
  if (gesture?.id === event.pointerId) {
    const {mode: previous, box} = gesture;
    gesture = null;
    if (['outline', 'cover'].includes(previous) && event.type === 'pointerup') {
      if (box?.w >= 2 && box.h >= 2) {
        if (previous === 'cover') coverBox = box;
        else outlineBox = box;
        setMode('move');
        previewMissing();
      } else status('Drag between opposite corners of the area.', true);
    }
  }
  touches.delete(event.pointerId);
  if (touches.size < 2) pinch = null;
};
new ResizeObserver(() => draw()).observe($('stage'));

function discardFill(layer) {
  if (selected === layer) draft = outlineBox = coverBox = null;
  if (!layer.fill) return;
  layer.fill = layer.fillMark = layer.fillSourceMask = layer.fillPlan = null;
  renderList();
  syncControls();
}

function previewMissing() {
  if (busy || !canComplete(selected)) return;
  draft = null;
  try {
    draft = makePlan(selected.mask, $('shape').value, outlineBox, coverBox);
    isolated = true;
    selected.visible = true;
    renderList();
    status(draft.count ? 'Amber shows the area AI will estimate.' :
      'This outline has no missing pixels. Draw a larger outline if part of the piece is hidden.');
  } catch (error) {
    status(error.message, true);
  }
  syncControls();
  draw();
}

$('shape').onchange = () => {
  outlineBox = null;
  previewMissing();
};
$('previewFill').onclick = previewMissing;
function startShapeDraw(tool) {
  if (busy || !canComplete(selected)) return;
  if (mode === tool) {
    setMode('move');
    return;
  }
  if (tool === 'outline' && $('shape').value === 'auto') $('shape').value = 'round';
  isolated = true;
  selected.visible = true;
  draft = null;
  renderList();
  syncControls();
  setMode(tool);
  const hint = tool === 'cover' ? 'Drag a rectangle around the piece that covers the target.' :
    'Drag from one corner of the full outline to the opposite corner.';
  status(hint);
  $('fillHelp').textContent = hint;
  if (matchMedia('(max-width: 760px)').matches) view.scrollIntoView({block: 'nearest'});
}
$('drawOutline').onclick = () => startShapeDraw('outline');
$('drawCover').onclick = () => startShapeDraw('cover');
$('clearCover').onclick = () => {
  coverBox = null;
  previewMissing();
};
$('showFill').onchange = $('markFill').onchange = () => draw();
$('clearFill').onclick = () => {
  discardFill(selected);
  status('Removed the AI estimate. Source pixels are still available.');
  draw();
};
$('generateFill').onclick = async () => {
  if (busy || !canComplete(selected)) return;
  if (!draft) previewMissing();
  if (!draft?.count) return;
  const layer = selected, plan = draft;
  setMode('move');
  setBusy(true);
  try {
    const {generated, symmetryUsed} = await completeLayer(working, plan, $('symmetry').checked, message => {
      status(message);
      $('fillHelp').textContent = message;
    });
    layer.fill = generated;
    layer.fillMark = plan.missing;
    layer.fillSourceMask = plan.mask;
    layer.fillPlan = {cover: plan.cover, clipTarget: plan.clipTarget, symmetryUsed};
    if (draft === plan) draft = null;
    $('showFill').checked = true;
    renderList();
    draw();
    status(symmetryUsed ? 'AI fill ready with symmetry guidance.' :
      'AI fill ready. Use Highlight generated pixels to compare it with the source.');
  } catch (error) {
    status(error.message, true);
  } finally {
    setBusy(false);
  }
};

async function exportPng(layer, apply, variant = 'source') {
  const {width, height} = photo;
  const output = canvas(width, height);
  const result = output.getContext('2d');
  if (!result) throw new Error('This device could not allocate the export canvas.');
  try {
    if (apply) {
      result.translate(width / 2 + layer.x, height / 2 + layer.y);
      result.rotate(layer.rotation * Math.PI / 180);
      result.translate(-width / 2, -height / 2);
      result.globalAlpha = layer.opacity;
    }
    if (variant !== 'generated') {
      result.drawImage(photo, 0, 0);
      result.globalAlpha = 1;
      result.globalCompositeOperation = 'destination-in';
      result.imageSmoothingEnabled = false;
      result.drawImage(variant === 'completed' ? layer.fillSourceMask : layer.mask, 0, 0, width, height);
    }
    if (variant !== 'source') {
      result.globalAlpha = apply ? layer.opacity : 1;
      result.globalCompositeOperation = 'destination-over';
      result.imageSmoothingEnabled = false;
      result.drawImage(layer.fill, 0, 0, width, height);
    }
    return await new Promise((resolve, reject) => output.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('The browser could not encode this image.'));
    }, 'image/png'));
  } finally {
    output.width = output.height = 0;
  }
}

const safe = name => name.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '') || 'layer';
function download(blob, name) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30000);
}
$('original').onclick = () => {
  download(originalFile, originalFile.name);
  status('Original photo download started.');
};
$('viewPng').onclick = async () => {
  setBusy(true);
  status('Encoding the current view…');
  try {
    draw(false);
    const blob = await new Promise((resolve, reject) => view.toBlob(result => {
      if (result) resolve(result);
      else reject(new Error('The browser could not encode this view.'));
    }, 'image/png'));
    const includesFill = $('showFill').checked && mode !== 'tap' &&
      layers.some(layer => layer.fill && layer.visible && (!isolated || layer === selected));
    download(blob, safe(filename) + '-' + viewMode + (includesFill ? '-with-ai-fill' : '') + '.png');
    status('View PNG download started.');
  } catch (error) {
    status('View export failed. ' + error.message, true);
  } finally {
    draw();
    setBusy(false);
  }
};
$('png').onclick = async () => {
  setBusy(true);
  status('Encoding transparent PNG…');
  try {
    const layer = selected;
    download(await exportPng(layer, $('edited').checked), safe(layer.name) + '.png');
    status('PNG download started.');
  } catch (error) {
    status('PNG export failed. ' + error.message, true);
  } finally {
    setBusy(false);
  }
};
$('saveFill').onclick = async () => {
  const layer = selected;
  setBusy(true);
  try {
    download(await exportPng(layer, $('edited').checked, 'completed'), safe(layer.name) + '-ai-completed.png');
    status('Completed PNG download started.');
  } catch (error) {
    status('Completed PNG export failed. ' + error.message, true);
  } finally {
    setBusy(false);
  }
};
$('zip').onclick = async () => {
  setBusy(true);
  try {
    const apply = $('edited').checked;
    const entries = {};
    const metadata = {source: 'Visible pixels from the source photograph', width: photo.width,
      height: photo.height, transformsBaked: apply, layerOrder: 'bottom-to-top',
      processing: {inference: 'Local LiteRT WASM', generatedPixels: layers.some(layer => !!layer.fill),
        models: ['SelfieMulticlass', 'EfficientDet-Lite0', 'MagicTouch'], previewMode: viewMode, previewStyle: globalStyle}, layers: []};
    for (const [i, layer] of layers.entries()) {
      status('Encoding layer ' + (i + 1) + ' of ' + layers.length + '…');
      const name = String(i + 1).padStart(2, '0') + '-' + safe(layer.name) + '.png';
      entries[name] = new Uint8Array(await (await exportPng(layer, apply)).arrayBuffer());
      const record = {file: name, name: layer.name, method: layer.method, visible: layer.visible,
        width: photo.width, height: photo.height, opacity: layer.opacity, x: layer.x, y: layer.y,
        rotation: layer.rotation, previewStyle: layer.style};
      if (layer.fill) {
        const stem = name.slice(0, -4);
        const completedFile = stem + '-ai-completed.png';
        const generatedFile = stem + '-ai-only.png';
        entries[completedFile] = new Uint8Array(await (await exportPng(layer, apply, 'completed')).arrayBuffer());
        entries[generatedFile] = new Uint8Array(await (await exportPng(layer, apply, 'generated')).arrayBuffer());
        record.reconstruction = {model: 'LaMa', method: 'Estimated missing pixels',
          symmetryUsed: layer.fillPlan.symmetryUsed, completedFile, generatedFile};
      }
      metadata.layers.push(record);
    }
    entries['layers.json'] = strToU8(JSON.stringify(metadata, null, 2));
    const zip = zipSync(entries, {level: 0});
    download(new Blob([zip], {type: 'application/zip'}), safe(filename) + '-layers.zip');
    status('ZIP download started with ' + layers.length + ' transparent PNGs.');
  } catch (error) {
    status('ZIP export failed. ' + error.message, true);
  } finally {
    setBusy(false);
  }
};

const offlineLabel = $('offline').querySelector('span');
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(async () => {
    offlineWorker = (await navigator.serviceWorker.ready).active;
    if (localStorage.getItem('layerpeel-offline-9') === 'ready' &&
        await caches.match(new URL('models/touch.tflite', location.href))) offlineLabel.textContent = 'Offline ready';
  }).catch(() => { offlineLabel.textContent = 'Offline unavailable'; });
} else {
  offlineLabel.textContent = 'Offline unavailable';
  $('offline').disabled = true;
}
$('offline').onclick = () => {
  if (!offlineWorker) {
    status('Offline setup is unavailable in this browser context.', true);
    return;
  }
  $('offline').disabled = true;
  const channel = new MessageChannel();
  offlineWorker.postMessage('download', [channel.port2]);
  status('Downloading the editor and AI models (about 100 MB)…');
  offlineLabel.textContent = 'Downloading…';
  channel.port1.onmessage = ({data}) => {
    if (data.ready || data.error) {
      $('offline').disabled = false;
      channel.port1.close();
    }
    if (data.ready) {
      localStorage.setItem('layerpeel-offline-9', 'ready');
      offlineLabel.textContent = 'Offline ready';
      status('Offline ready. The editor and AI models are cached on this device.');
    } else if (data.error) {
      offlineLabel.textContent = 'Enable offline';
      status('Offline download failed. ' + data.error, true);
    } else {
      offlineLabel.textContent = 'Caching ' + data.done + '/' + data.total;
    }
  };
};

syncStyleControls();
syncControls();


// BeatVision generates an independent reference image. It never replaces an
// extracted layer or claims reconstruction of hidden pixels.
let beatvisionGeneratedImage = null;
$('beatvisionGenerate').onclick = async () => {
  const button = $('beatvisionGenerate');
  const message = $('beatvisionStatus');
  const preview = $('beatvisionResult');
  button.disabled = true;
  message.textContent = 'Contacting the authenticated BeatVision image bridge…';
  preview.hidden = true;
  preview.style.display = 'none';
  $('beatvisionDownload').disabled = true;
  beatvisionGeneratedImage = null;
  try {
    const {generateBeatVisionReference} = await import('./beatvision-generator.js?v=11');
    const result = await generateBeatVisionReference($('beatvisionPrompt').value);
    beatvisionGeneratedImage = result.imageUrl;
    preview.src = result.imageUrl;
    preview.hidden = false;
    preview.style.display = 'block';
    $('beatvisionDownload').disabled = false;
    message.textContent = 'AI GENERATED · FLUX.1 Schnell reference. Not source pixels or inpainting.';
  } catch (error) {
    message.textContent = 'BLOCKED · ' + error.message;
  } finally {
    button.disabled = false;
  }
};
$('beatvisionDownload').onclick = async () => {
  if (!beatvisionGeneratedImage) return;
  try {
    const response = await fetch(beatvisionGeneratedImage);
    if (!response.ok) throw new Error('Could not retrieve the generated image.');
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) throw new Error('Image response has an invalid type.');
    download(blob, 'beatvision-ai-generated-reference.' + (blob.type.includes('jpeg') ? 'jpg' : blob.type.includes('webp') ? 'webp' : 'png'));
  } catch (error) {
    $('beatvisionStatus').textContent = 'Export failed · ' + error.message;
  }
};
