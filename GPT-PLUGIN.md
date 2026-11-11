# LayerPeel Studio GPT connection

This adds three authenticated MCP tools to the existing app: `layerpeel_status`, `layerpeel_run`, and `layerpeel_result`.

1. Open LayerPeel Studio, choose a photo, and press **Connect to GPT**.
2. Install/connect the LayerPeel Studio plugin in ChatGPT.
3. Ask GPT to separate the connected photo, change the view, edit a layer, or export PNG/ZIP. Keep the editor open. Android can suspend background tabs; return to the editor if a command stays queued.

The browser runs existing LiteRT segmentation and LaMa reconstruction. No new GPU service or paid provider is provisioned. A reconstruction command needs a selected layer and prepared missing-region outline in the editor. Source and generated exports stay separate. X-Ray is a visualization, not hidden-content detection.

Connecting shares layer metadata and edit settings with the authenticated owner's GPT connection. PNG/ZIP files are uploaded only when GPT requests an export, with a 16 MB transfer limit. Owner-authenticated downloads are stored in the Site's R2 bucket. Metadata, latest command, and export files persist until overwritten or removed; automatic expiry is not implemented. The original image remains in the browser.

The standalone GitHub Pages app still works offline; the GPT bridge requires this authenticated Site backend. `/api/layerpeel/generate` explicitly returns BLOCKED because the separate BeatVision text-to-image adapter has no connected backend.

Validation: `node --test tests/*.test.mjs`; build: `node scripts/build-plugin.mjs`.
