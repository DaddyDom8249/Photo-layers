import * as ort from './reconstruction/ort.wasm.min.mjs';

const size = 512;
const area = size * size;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 1, 4) : 1;
ort.env.wasm.wasmPaths = new URL('./reconstruction/', import.meta.url).href;

async function loadWeights() {
  const parts = await Promise.all(['lama-0', 'lama-1'].map(async name => {
    const response = await fetch(new URL('./reconstruction/' + name, import.meta.url));
    if (!response.ok) throw new Error('Could not download the AI fill model.');
    return new Uint8Array(await response.arrayBuffer());
  }));
  const bytes = new Uint8Array(parts[0].length + parts[1].length);
  bytes.set(parts[0]);
  bytes.set(parts[1], parts[0].length);
  return bytes;
}

self.onmessage = async ({data: {rgb, holes}}) => {
  let session;
  try {
    self.postMessage({status: 'Loading AI fill model…'});
    session = await ort.InferenceSession.create(await loadWeights(), {
      executionProviders: ['wasm'],
      extra: {session: {disable_quant_qdq: '1'}}
    });
    self.postMessage({status: 'Reconstructing missing pixels on this device…'});
    const image = new Float32Array(area * 3);
    const mask = new Float32Array(area);
    for (let i = 0; i < area; i++) {
      image[i] = rgb[i * 4] / 255;
      image[i + area] = rgb[i * 4 + 1] / 255;
      image[i + area * 2] = rgb[i * 4 + 2] / 255;
      mask[i] = holes[i * 4 + 3] ? 1 : 0;
    }
    const {output} = await session.run({
      image: new ort.Tensor('float32', image, [1, 3, size, size]),
      mask: new ort.Tensor('float32', mask, [1, 1, size, size])
    });
    const values = output.data;
    if (values.length !== area * 3 || !values.every(Number.isFinite)) {
      throw new Error('The AI fill model returned invalid pixels.');
    }
    const pixels = new Uint8ClampedArray(area * 4);
    for (let i = 0; i < area; i++) {
      pixels[i * 4] = values[i];
      pixels[i * 4 + 1] = values[i + area];
      pixels[i * 4 + 2] = values[i + area * 2];
      pixels[i * 4 + 3] = 255;
    }
    self.postMessage({pixels}, [pixels.buffer]);
  } catch (error) {
    self.postMessage({error: error.message});
  } finally {
    await session?.release();
  }
};
