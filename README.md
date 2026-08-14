# Shaderbox

Run shaders from ShaderToy on any webpage using a WebComponent, optionally add
form controls to your shaders.

## Quickstart

### Export shaders from shadertoy

You can export a shader either from ShaderToy API if you have an API key, or
from using the devtools to save the JSON loaded by the ShaderToy player (this is
the POST request to `https://www.shadertoy.com/shadertoy` (right click > Save
reply as).

There are a few shaders already saved from ShaderToy in `examples/`. You can
convert them for use with shaderbox by running :

```
python fetch_shader.py --json-file examples/ --out shaders/
```

This will convert all shaders in `examples/` and put each shader in its own dir
under `shaders/`. During the export process, you will be prompted to manually
download texture files from ShaderToy (cloudflare prevents the script from
automatically fetching them). Each texture file needs to be downloaded only once.

### Embed a shader in a webpage

Host the content of the `static/` directory anywhere on your website, and
include `shaderbox.js` in your HTML (the CSS will be auto-added by the script).

```html
<head>
  <!-- ... -->
  <script defer src="static/shaderbox.js"></script>
</head>
```

Then, in your page body, use the `shader-box` custom element, and the path to
the directory of your exported shader in the `shader` attribute.

```html
<body>
  <!-- ... -->
  <shader-box shader="shaders/mitosis">
  </shader-box>
  <!-- ... -->
</body>
```

### Start a HTTP server

This will not work over `file://`, you need an HTTP server to serve the shader
files. You can start one using `python -m http.server` from this repository's
root directory. Any HTTP server that is able to serve static files should be
compatible.

### Add form controls to your shaders

You can add a HTML form with any number of inputs inside the `shader-box`
element :

```html
<shader-box shader="shaders/mitosis">
  <form>
    k2: <input type="number" name="k2" min="0.0" max="0.1" step="0.0001"
               value="0.057"><br>
    k3: <input type="number" name="k3" min="0.0" max="0.1" step="0.0001"
               value="0.019"><br>
  </form>
</shader-box>
```

This will create and handle uniforms for you. Since `k2` and `k3` were already
definied in `shaders/mitosis/common.glsl`, you will need to comment them out of
the GLSL source.

The uniforms are named after the `name` attributes of the form inputs, and are
attached to all buffers of the corresponding shader.

⚠️ For now, all form-controlled uniforms are floats.

#### Custom form styling and positionning

You can optionally add an `id` to your `shader-box`, then target it with a HTML
form using `aria-controls` :

```html
<shader-box id="burning" shader="shaders/burning_spirals">
</shader-box>
<form aria-controls="burning">
  k2: <input name="k2" type="number" min="0.0" max="0.1" step="0.0001"><br>
  k3: <input name="k3" type="number" min="0.0" max="0.1" step="0.0001"><br>
  j2: <input name="j2" type="number" min="0.0" max="0.1" step="0.0001"><br>
  j3: <input name="j3" type="number" min="0.0" max="0.1" step="0.0001"><br>
  feedrate: <input name="feedrate" type="number" min="0.0" max="0.1"
                   step="0.0001"><br>
  eatrate: <input name="eatrate" type="number" min="0.0" max="0.1"
                  step="0.0001"><br>
</form>
```
