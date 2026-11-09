export const presets = {
  normal: {intensity: 0, detail: 0, contrast: 0, brightness: 0, material: 0},
  xray: {intensity: 100, detail: 35, contrast: 16, brightness: 6, material: 0},
  gray: {intensity: 0, detail: 0, contrast: 0, brightness: 0, material: 0},
  edge: {intensity: 0, detail: 100, contrast: 12, brightness: 0, material: 0},
  material: {intensity: 0, detail: 17, contrast: 8, brightness: 0, material: 86}
};

export function styleFor(preset) {
  return {preset, ...presets[preset]};
}

const palette = {
  hair: [248, 232, 99],
  'skin / body (visible)': [134, 220, 112],
  face: [249, 141, 167],
  clothing: [111, 140, 255],
  accessories: [246, 226, 166],
  subject: [108, 223, 175]
};

export function prepareSource(context, width, height) {
  const pixels = context.getImageData(0, 0, width, height);
  const luminance = new Uint8Array(width * height);
  const edges = new Uint8Array(width * height);
  const rgba = pixels.data;
  for (let i = 0; i < luminance.length; i++) {
    luminance[i] = .2126 * rgba[4 * i] + .7152 * rgba[4 * i + 1] + .0722 * rgba[4 * i + 2];
  }
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const dx = luminance[i + 1] - luminance[i - 1];
      const dy = luminance[i + width] - luminance[i - width];
      edges[i] = Math.min(255, 1.5 * (Math.abs(dx) + Math.abs(dy)));
    }
  }
  return {pixels, luminance, edges};
}

export function isPlain(style) {
  return style.preset === 'normal' && !style.intensity && !style.detail &&
    !style.contrast && !style.brightness && !style.material;
}

export function renderStyle(context, source, style, label) {
  const {pixels, luminance, edges} = source;
  const output = context.createImageData(pixels.width, pixels.height);
  const tint = palette[label.toLowerCase().split(' · ')[0]] || [94, 223, 183];
  const contrast = (100 + style.contrast) / 100;
  const brightness = style.brightness * 1.55;
  const intensity = style.intensity / 100;
  const material = label === 'Background' ? 0 : style.material / 100;
  const detail = style.detail / 100;
  const gray = style.preset === 'gray';
  const edgeMode = style.preset === 'edge';
  for (let i = 0; i < luminance.length; i++) {
    const j = i * 4;
    const light = luminance[i];
    const ray = 255 - light;
    const edge = edges[i];
    // An inverted blue-white luminance map and a gradient of visible RGB pixels.
    const blueR = Math.max(0, ray * 1.24 - 57);
    const blueG = ray * 1.02 + 13;
    const blueB = ray * .74 + 54;
    for (let c = 0; c < 3; c++) {
      const blue = c === 0 ? blueR : c === 1 ? blueG : blueB;
      const base = gray ? light : pixels.data[j + c];
      const mapped = base + (blue - base) * intensity;
      const materialValue = tint[c] * (.27 + light / 350);
      const colored = mapped + (materialValue - mapped) * material;
      const outlined = edgeMode ? colored * (1 - detail) + edge * detail : colored + edge * detail;
      output.data[j + c] = (outlined - 128) * contrast + 128 + brightness;
    }
    output.data[j + 3] = pixels.data[j + 3];
  }
  context.putImageData(output, 0, 0);
}
