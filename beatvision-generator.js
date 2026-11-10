/**
 * BeatVision image-generation client.
 * The proxy is server-side and MUST authenticate requests and hold its gateway token.
 * Never place a GATEWAY_TOKEN, Cloudflare key, or Modal key in this static site.
 * This is text-to-image reference generation, not image inpainting.
 */
const ENDPOINT = '/api/layerpeel/generate';
export async function generateBeatVisionReference(prompt) {
  const description = String(prompt || '').trim();
  if (description.length < 8 || description.length > 1200) {
    throw new Error('Enter a descriptive prompt (8–1200 characters).');
  }
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: description, purpose: 'reference-image', model: 'flux-schnell' }),
  });
  const raw = await response.text();
  let result;
  try { result = JSON.parse(raw); }
  catch { throw new Error(response.status === 404 ? 'BeatVision server bridge is not deployed.' : 'BeatVision bridge returned invalid JSON.'); }
  if (!response.ok || result.ok === false) {
    throw new Error(String(result.error || result.message || 'BeatVision image generation failed.').slice(0, 250));
  }
  const uri = result.image_data_url || result.image_url;
  if (typeof uri !== 'string' || !(/^(data:image\/(png|jpeg|webp);base64,)/i.test(uri) || /^https:\/\//i.test(uri))) {
    throw new Error('BeatVision bridge returned no supported image URL.');
  }
  return { imageUrl: uri, model: 'flux-schnell', provenance: 'AI-generated reference; not extracted or reconstructed source pixels' };
}
