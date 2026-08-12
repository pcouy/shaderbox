#!/usr/bin/env python3
"""
Turn a shader into a directory of .glsl files (one per tab) plus a
config.json describing channel wiring — ready to be loaded by the
companion JS multipass runtime.

Two ways to get the shader data in:

  1. Official API (needs a free key from https://www.shadertoy.com/myapps):
       python fetch_shader.py <shader_id_or_view_url> --api-key KEY
     or set SHADERTOY_API_KEY in the environment.

  2. A JSON file saved by hand from the browser (no key needed) — open the
     shader page, open devtools > Network, reload, find the XHR request
     that returns the shader JSON (a request to .../shadertoy or similar),
     and save its response body to a file:
       python fetch_shader.py --json-file saved_shader.json

     This format is a bare list `[ { "info": {...}, "renderpass": [...] } ]`,
     slightly different from the official API's `{"Shader": {...}}` wrapper —
     both are handled automatically.

Example:
    python fetch_shader.py https://www.shadertoy.com/view/XdlSD8 --out shaders/mine
    -> shaders/mine/
         common.glsl      (empty file if the shader has no Common tab)
         image.glsl
         bufferA.glsl     (only written if that buffer exists)
         config.json

Supported channel types: buffer, texture, keyboard. Anything else (video,
webcam, music, cubemap, volume, font, mic) is flagged as unsupported in
config.json — the code is still saved, but that channel needs manual wiring.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

API_BASE = "https://www.shadertoy.com/api/v1/shaders/"
SITE_BASE = "https://www.shadertoy.com"

# Shadertoy's renderpass "name" strings -> the pass keys used by config.json
# / the JS runtime (must match the CHANNELS keys the JS expects).
PASS_NAME_MAP = {
    "Image": "Image",
    "Common": "Common",
    "Buf A": "BufferA",
    "Buf B": "BufferB",
    "Buf C": "BufferC",
    "Buf D": "BufferD",
    "Buffer A": "BufferA",
    "Buffer B": "BufferB",
    "Buffer C": "BufferC",
    "Buffer D": "BufferD",
    "Cube A": "CubemapA",
    "Sound": "Sound",
}


def extract_id(s: str) -> str:
    m = re.search(r"shadertoy\.com/view/([A-Za-z0-9]+)", s)
    return m.group(1) if m else s.strip()


def fetch_shader_json(shader_id: str, api_key: str) -> dict:
    url = f"{API_BASE}{shader_id}?key={api_key}"
    try:
        with urllib.request.urlopen(url) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP error {e.code} fetching shader '{shader_id}': {e.reason}")
    except urllib.error.URLError as e:
        sys.exit(f"Network error fetching shader '{shader_id}': {e.reason}")

    if "Error" in data:
        sys.exit(f"Shadertoy API error: {data['Error']}")
    if "Shader" not in data:
        sys.exit(f"Unexpected API response: {json.dumps(data)[:300]}")
    return data["Shader"]


def normalize_shader_obj(data) -> dict:
    """Accepts either the official API's {"Shader": {...}} wrapper, or the
    bare list [{...}] format returned by the site's own internal endpoint
    (what you get pasting a devtools response into a file)."""
    if isinstance(data, list):
        if not data:
            sys.exit("JSON file contains an empty list.")
        data = data[0]
    if isinstance(data, dict):
        if "Shader" in data:
            return data["Shader"]
        if "renderpass" in data:
            return data
    sys.exit("Could not find a shader object (expected a 'renderpass' key) in the given JSON.")


def build_id_to_pass_key(renderpasses: list) -> dict:
    """Map each renderpass's output id -> our pass key. Needed because the
    API expresses buffer-to-buffer channel references as matching
    input/output ids, not by name."""
    mapping = {}
    for rp in renderpasses:
        key = PASS_NAME_MAP.get(rp["name"], rp["name"])
        for out in rp.get("outputs", []):
            mapping[out["id"]] = key
    return mapping


def resolve_channel(inp: dict, id_to_pass: dict):
    # Input objects use "type" for the channel's content type (buffer,
    # texture, keyboard, cubemap, ...) and "filepath" for the asset path.
    ctype = inp.get("type")
    channel = inp["channel"]
    if ctype == "buffer":
        target = id_to_pass.get(inp["id"])
        if target is None:
            return channel, {"unsupported": "buffer (could not resolve source pass)"}
        return channel, {"buffer": target.replace("Buffer", "")}
    if ctype == "texture":
        return channel, {"texture": SITE_BASE + inp["filepath"]}
    if ctype == "keyboard":
        return channel, {"keyboard": True}
    return channel, {"unsupported": ctype or "unknown"}


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("shader", nargs="?", help="Shadertoy shader ID or full view URL (uses the API)")
    ap.add_argument("--json-file", help="Path to a shader JSON response saved by hand (skips the API)")
    ap.add_argument(
        "--api-key",
        default=os.environ.get("SHADERTOY_API_KEY"),
        help="Shadertoy API key (or set SHADERTOY_API_KEY env var)",
    )
    ap.add_argument("--out", default=None, help="Output directory (default: ./shaders/<id>)")
    args = ap.parse_args()

    if not args.shader and not args.json_file:
        sys.exit("Provide either a shader ID/URL or --json-file.")
    if args.shader and args.json_file:
        sys.exit("Provide either a shader ID/URL or --json-file, not both.")

    if args.json_file:
        with open(args.json_file) as f:
            raw = json.load(f)
        shader = normalize_shader_obj(raw)
        shader_id = shader.get("info", {}).get("id") or os.path.splitext(os.path.basename(args.json_file))[0]
    else:
        if not args.api_key:
            sys.exit(
                "No API key given. Get one at https://www.shadertoy.com/myapps "
                "and pass --api-key, or set SHADERTOY_API_KEY. Alternatively, "
                "use --json-file with a devtools-saved response (no key needed)."
            )
        shader_id = extract_id(args.shader)
        shader = fetch_shader_json(shader_id, args.api_key)

    info = shader.get("info", {})
    renderpasses = shader["renderpass"]

    out_dir = args.out or os.path.join("shaders", shader_id)
    os.makedirs(out_dir, exist_ok=True)

    id_to_pass = build_id_to_pass_key(renderpasses)

    channels = {}
    passes_present = {}
    warnings = []

    for rp in renderpasses:
        key = PASS_NAME_MAP.get(rp["name"], rp["name"])
        code = rp.get("code", "")

        if key in ("Sound", "CubemapA"):
            warnings.append(
                f"Pass '{rp['name']}' is not supported by the JS runtime yet; "
                f"code was still saved to {key.lower()}.glsl for reference."
            )

        filename = f"{key[0].lower()}{key[1:]}.glsl"
        with open(os.path.join(out_dir, filename), "w") as f:
            f.write(code)

        if key == "Common":
            continue  # Common has no channel inputs of its own

        passes_present[key] = True
        slots = [None, None, None, None]
        for inp in rp.get("inputs", []):
            idx, resolved = resolve_channel(inp, id_to_pass)
            slots[idx] = resolved
            if "unsupported" in resolved:
                warnings.append(
                    f"{key} channel {idx}: unsupported input type "
                    f"'{resolved['unsupported']}' — wire this up manually if needed."
                )
        channels[key] = slots

    config = {
        "id": shader_id,
        "name": info.get("name", ""),
        "author": info.get("username", ""),
        "description": info.get("description", ""),
        "source": f"{SITE_BASE}/view/{shader_id}",
        "license_note": (
            "Shadertoy shaders default to CC BY-NC-SA 3.0 unless the author "
            "states otherwise on the shader page — verify before redistributing "
            "anything that isn't your own work."
        ),
        "passes": passes_present,
        "channels": channels,
    }
    with open(os.path.join(out_dir, "config.json"), "w") as f:
        json.dump(config, f, indent=2)

    print(f"Wrote {out_dir}/")
    for fn in sorted(os.listdir(out_dir)):
        print(f"  {fn}")
    if warnings:
        print("\nWarnings:")
        for w in warnings:
            print(f"  - {w}")


if __name__ == "__main__":
    main()
