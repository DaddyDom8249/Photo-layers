# BeatVision image-generator integration — deployment gate

Status: **FRONTEND ADAPTER COMMITTED; LIVE CONNECTION BLOCKED**.

## Existing verified components
- LayerPeel frontend: `DaddyDom8249/Photo-layers`, a static website.
- Image provider: BeatVision Arena Cloudflare Worker, AI binding `@cf/black-forest-labs/flux-1-schnell` (existing BeatVision image path).
- Arena's `POST /v2/scene-image` is gateway-token protected and requires a locked BeatVision song/world/scene contract; it **must not** be called directly from this static page or forged using fictional song values.
- The legacy Arena client image route is also gateway-token protected and may depend on Pixazo. Do not use it as a free Cloudflare substitute.

## What is implemented
- A separate **BeatVision Image Generator** panel in LayerPeel's editor.
- Text prompt to `POST /api/layerpeel/generate` on the same origin using same-origin browser session credentials.
- Response preview, generated-image download, error/status feedback.
- No API keys in the HTML or JavaScript. Uploaded original photo, segmentation masks, layer edits, and source PNG exports remain untouched.
- Generated image is labeled as a separate AI reference, **not** inpainting or actual hidden layer pixels.

## Required server work before enabling generation
1. Deploy an authenticated same-origin backend endpoint `POST /api/layerpeel/generate` (e.g., a Vercel function, not GitHub Pages).
2. Verify the signed-in user's authorization server-side; do not accept anonymous public provider requests.
3. Implement a LayerPeel-specific, **text-to-image** operation in the existing Arena Worker using its AI binding, separate from BeatVision's Vision Lock contract. Restrict the model to Flux Schnell and retain the explicit `BEATVISION_FREE_WORKERS_AI_CONFIRMED` free-only fail-closed gate. Never silently substitute paid providers.
4. Keep `GATEWAY_TOKEN` solely in worker/backend secrets. Rate-limit, validate prompt length, cap image size, log request IDs, and return explicit quota/authorization/provider failures.
5. Backend response contract: `{ "ok": true, "image_data_url": "data:image/png;base64,...", "model": "flux-schnell" }` or `{ "ok": false, "error": "..." }`. An authenticated HTTPS `image_url` is also accepted by the frontend if image fetch is authorized.
6. Verify an authorized generation end-to-end on Android, check daily free quota behavior, rejected unauthenticated calls, no unauthorized CORS access, and no regression to BeatVision scene generation. Only then mark CONFIRMED.

**Technical limitation:** FLUX.1 Schnell is text-to-image. It does not perform masked, source-image-conditioned inpainting. For accurate hidden-object completion, retain the existing LayerPeel local inpainting path or integrate a separate purpose-built image-edit model later; mark all reconstructed pixels as AI estimates.
