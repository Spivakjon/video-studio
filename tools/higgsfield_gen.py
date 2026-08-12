#!/usr/bin/env python3
"""Higgsfield generation via the official SDK — image-to-video / text-to-video.

Reads HF_API_KEY + HF_API_SECRET from env. Uploads an optional input image,
submits to a model `application`, polls, and downloads the result video/image.

Usage:
  python tools/higgsfield_gen.py \
    --application "<model application id from the Higgsfield dashboard>" \
    --input videos/kikkaboo-teaser/assets/baby-il-walk.png \
    --prompt "the toddler walks forward..." \
    --image-key input_image \
    --args '{"aspect_ratio":"9:16","duration":5}' \
    --output videos/kikkaboo-teaser/clips/baby-walk.mp4

The exact --application id, --image-key, and --args keys come from the model's
API snippet on cloud.higgsfield.ai (varies per model). This wrapper is generic.
"""
import argparse, json, os, sys, time, urllib.request

def log(*a): print("  [higgsfield]", *a, flush=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--application", required=True, help="model application id/url from dashboard")
    ap.add_argument("--input", help="input image path (for image-to-video)")
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--image-key", default="input_image", help="arg key the model expects for the image URL")
    ap.add_argument("--prompt-key", default="prompt")
    ap.add_argument("--args", default="{}", help="extra arguments as JSON")
    ap.add_argument("--output", required=True)
    a = ap.parse_args()

    # Load credentials from .higgsfield/config.json if present (easier than env vars).
    _cfg = os.path.join(os.path.dirname(__file__), "..", ".higgsfield", "config.json")
    if os.path.exists(_cfg):
        try:
            c = json.load(open(_cfg, encoding="utf-8"))
            if c.get("api_key"):    os.environ["HF_API_KEY"] = str(c["api_key"]).strip()
            if c.get("api_secret"): os.environ["HF_API_SECRET"] = str(c["api_secret"]).strip()
        except Exception as e:
            log("config.json read error:", e)

    if not (os.getenv("HF_API_KEY") and os.getenv("HF_API_SECRET")) and not os.getenv("HF_KEY"):
        log("ERROR: no credentials. Fill .higgsfield/config.json with api_key + api_secret."); sys.exit(2)

    import higgsfield_client as hf
    try:
        from PIL import Image
    except ImportError:
        log("ERROR: Pillow needed (pip install pillow)"); sys.exit(2)

    arguments = json.loads(a.args)
    if a.prompt is not None:
        arguments[a.prompt_key] = a.prompt
    if a.input:
        log(f"uploading image {a.input} …")
        img = Image.open(a.input)
        url = hf.upload_image(img)
        arguments[a.image_key] = url
        log(f"image url: {url}")

    log(f"submitting to {a.application} …")
    log(f"arguments: {json.dumps(arguments)[:300]}")
    rc = hf.submit(a.application, arguments=arguments)

    last = None
    for status in rc.poll_request_status():
        name = type(status).__name__
        if name != last:
            log(f"status: {name}"); last = name
        if name in ("Completed", "Failed", "NSFW", "Cancelled"):
            break
        time.sleep(2)

    if last in ("Failed", "Cancelled"):
        log(f"FAILED: {last}"); sys.exit(1)
    if last == "NSFW":
        log("BLOCKED: flagged NSFW — rephrase / different image."); sys.exit(1)

    res = rc.get()
    # find a video/image url anywhere in the result
    def find_url(o):
        if isinstance(o, str) and o.startswith("http"):
            return o
        if isinstance(o, dict):
            for k in ("url", "video", "videos", "output", "outputs", "result"):
                if k in o:
                    u = find_url(o[k])
                    if u: return u
            for v in o.values():
                u = find_url(v)
                if u: return u
        if isinstance(o, list):
            for v in o:
                u = find_url(v)
                if u: return u
        return None
    out_url = find_url(res)
    if not out_url:
        log("ERROR: no output URL in result:", json.dumps(res)[:400]); sys.exit(1)
    log(f"downloading {out_url} …")
    urllib.request.urlretrieve(out_url, a.output)
    log(f"SAVED: {a.output}")

if __name__ == "__main__":
    main()
