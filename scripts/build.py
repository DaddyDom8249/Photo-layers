"""Assemble the static editor and verify its public model weights."""
from hashlib import sha256
from math import sqrt
from pathlib import Path
from shutil import copy2, rmtree
from struct import pack
from subprocess import run

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
NODE = ROOT / "node_modules"
MEDIAPIPE = "https://storage.googleapis.com/mediapipe-models/"
MODELS = {
    "portrait": (
        "image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite",
        "c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0",
    ),
    "objects": (
        "object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite",
        "0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb",
    ),
    "touch": (
        "interactive_segmenter/magic_touch/float32/1/magic_touch.tflite",
        "e24338a717c1b7ad8d159666677ef400babb7f33b8ad60c4d96db4ecf694cd25",
    ),
}
LAMA = ("https://huggingface.co/othytenk/lama-int4-int8/resolve/"
        "b52ebb642126086fe3da1524a3b1d7629ae4c6a9/lama_int4_int8_r4.onnx")
LAMA_SHA = "4e3b78a253eb4abf21896811c928ffa91214b916e5d6ced24cecdd7999b4aaa1"


def copy(source, target):
    destination = DIST / target
    destination.parent.mkdir(parents=True, exist_ok=True)
    copy2(source, destination)


def download(url, target, digest):
    destination = DIST / target
    run(["curl", "--fail", "--silent", "--show-error", "--location", "--retry", "3",
         "--max-time", "180", "--output", str(destination), url], check=True)
    if sha256(destination.read_bytes()).hexdigest() != digest:
        raise RuntimeError(f"Checksum mismatch for {target}")
    return destination


def detector_anchors():
    """EfficientDet-Lite0 P3–P7 anchors, ordered by cell, scale and aspect ratio."""
    sizes = zip((40, 20, 10, 5, 3), (.075, .15, .30, .60, 1))
    with (DIST / "models/anchors.bin").open("wb") as output:
        for side, base in sizes:
            for y in range(side):
                for x in range(side):
                    for step in range(3):
                        size = base * 2 ** (step / 3)
                        for ratio in (1, 2, .5):
                            width = size * sqrt(ratio)
                            height = size / sqrt(ratio)
                            output.write(pack("<4f", (x + .5) / side, (y + .5) / side, width, height))


def main():
    if DIST.exists():
        rmtree(DIST)
    DIST.mkdir()
    for name in ("index.html", "app.js", "engine.js", "filter.js", "styles.js",
                 "completion.js", "completion-worker.js", "sw.js", "style.css",
                 "icon.svg", "icon-192.png", "icon-512.png", "manifest.webmanifest",
                 "LICENSE.txt", "FFLATE-LICENSE.txt", "NSFWJS-LICENSE.txt",
                 "TENSORFLOW-LICENSE.txt", "vision/LICENSE.txt", "models/labels.js",
                 "reconstruction/LAMA-LICENSE.txt", "reconstruction/NOTICE.txt",
                 "reconstruction/ONNX-RUNTIME-LICENSE.txt"):
        copy(ROOT / name, name)

    litert = NODE / "@litertjs/core"
    for variant in ("internal", "compat_internal"):
        for suffix in ("js", "wasm"):
            name = f"wasm/litert_wasm_{variant}.{suffix}"
            copy(litert / name, f"vision/{name}")
    for name in ("ort.wasm.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"):
        copy(NODE / "onnxruntime-web/dist" / name, f"reconstruction/{name}")
    copy(NODE / "fflate/esm/browser.js", "zip.js")
    for entry, target in (("scripts/vision-entry.js", "vision/litert.js"),
                          ("scripts/filter-entry.js", "filter-model.js")):
        run([str(NODE / ".bin/esbuild"), entry, "--bundle", "--minify",
             "--platform=browser", "--format=esm", f"--outfile=dist/{target}"],
            check=True, cwd=ROOT)

    for name, (source, digest) in MODELS.items():
        download(MEDIAPIPE + source, f"models/{name}.tflite", digest)
    detector_anchors()
    download("https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/ThirdPartyNotices.txt",
             "reconstruction/ONNX-RUNTIME-THIRD-PARTY-NOTICES.txt",
             "143764b952fdb1a7c69ce653bfba74a7744d6a8a573bfb73e235fba356c83de3")
    weights = download(LAMA, "reconstruction/lama.onnx", LAMA_SHA)
    with weights.open("rb") as source:
        for i in range(2):
            (weights.parent / f"lama-{i}").write_bytes(source.read(18 * 1024 * 1024))
    weights.unlink()


if __name__ == "__main__":
    main()
