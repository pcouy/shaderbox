const shaderboxScriptSrc = document.currentScript.src;

function instantiateShader(htmlElement) {
    /* =========================================================================
       1. POINT AT A SHADER DIRECTORY
          Produced by the companion fetch_shader.py script:
            python fetch_shader.py <shader_id_or_url> --out shaders/myshader
          That writes common.glsl / image.glsl / bufferA.glsl.../ config.json
          into shaders/myshader/ — set SHADER_DIR to that folder (relative to
          this HTML file, or absolute). Must be served over http(s):// — fetch()
          can't read local files under file://.
       ========================================================================= */
    const SHADER_NAME = htmlElement.dataset["shader"];
    const SHADER_DIR = `${SHADER_NAME}`;
    const SHADER_ID = htmlElement.id || undefined;
    console.log(SHADER_ID);
    let controlForm = undefined;
    if (SHADER_ID !== undefined) {
        controlForm = document.querySelector(`[aria-controls="${SHADER_ID}"]`);
    }
    let controlsData = new FormData();
    if (controlForm) {
        controlsData = new FormData(controlForm);
        controlForm.addEventListener("change", ()=>{
            controlsData = new FormData(controlForm);
        });
    }
    let controlledUniforms = Array.from(
        controlsData.keys().map(k=>`uniform float ${k};`)
    ).join("\n    ");

    /* =========================================================================
       2. RUNTIME  (shouldn't need to touch anything below this line)
       ========================================================================= */

    const canvas = document.createElement('canvas');
    const errBox = document.createElement('pre');
    htmlElement.appendChild(canvas);
    htmlElement.appendChild(errBox);
    const gl = canvas.getContext('webgl2');
    if (!gl) fail('WebGL2 is not available in this browser.');

    function fail(msg){
      errBox.style.display = 'block';
      errBox.textContent += msg + '\n';
      console.error(msg);
      throw new Error(msg);
    }

    // Prefer float framebuffers (needed for accurate feedback/accumulation
    // buffers); fall back to 8-bit if the extension isn't available.
    const floatExt = gl.getExtension('EXT_color_buffer_float');
    const floatLinear = gl.getExtension('OES_texture_float_linear');
    const FMT = floatExt
      ? { internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, filter: floatLinear ? gl.LINEAR : gl.NEAREST }
      : { internalFormat: gl.RGBA8,   format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR };
    if (!floatExt) console.warn('EXT_color_buffer_float unavailable — buffers running at 8-bit precision.');

    // ---- ping-pong buffer helper -------------------------------------------
    class PingPong {
      constructor(w, h){
        this.tex = [this.makeTex(w,h), this.makeTex(w,h)];
        this.fbo = [this.makeFBO(this.tex[0]), this.makeFBO(this.tex[1])];
        this.idx = 0;
        this.w = w; this.h = h;
        this.wrapping = gl.REPEAT;
      }
      makeTex(w,h){
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, FMT.internalFormat, w, h, 0, FMT.format, FMT.type, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, FMT.filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, FMT.filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, this.wrapping);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, this.wrapping);
        return t;
      }
      makeFBO(tex){
        const f = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, f);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return f;
      }
      get front(){ return this.tex[this.idx]; }
      get backFBO(){ return this.fbo[1 - this.idx]; }
      swap(){ this.idx = 1 - this.idx; }
      resize(w,h){
        this.w = w; this.h = h;
        for (let i=0;i<2;i++){
          gl.bindTexture(gl.TEXTURE_2D, this.tex[i]);
          gl.texImage2D(gl.TEXTURE_2D, 0, FMT.internalFormat, w, h, 0, FMT.format, FMT.type, null);
        }
      }
    }

    // ---- shader compilation --------------------------------------------------
    const VERT = `#version 300 es
    void main(){
      vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
      gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
    }`;

    function wrapFragment(src, common){
      return `#version 300 es
    precision highp float;
    precision highp int;
    uniform vec3  iResolution;
    uniform float iTime;
    uniform float iTimeDelta;
    uniform int   iFrame;
    uniform vec4  iMouse;
    uniform vec4  iDate;
    uniform float iSampleRate;
    uniform vec3  iChannelResolution[4];
    uniform sampler2D iChannel0;
    uniform sampler2D iChannel1;
    uniform sampler2D iChannel2;
    uniform sampler2D iChannel3;
    #define texture2D texture
    #define textureCube texture
    #define texture2DLod textureLod
    out vec4 fragColor;

    ${controlledUniforms}

    ${common}

    ${src}

    void main(){ mainImage(fragColor, gl_FragCoord.xy); }
    `;
    }

    function compile(type, src){
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
        fail(gl.getShaderInfoLog(s) + '\n---\n' + src);
      }
      return s;
    }

    function makeProgram(fragSrc, common){
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, wrapFragment(fragSrc, common)));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) fail(gl.getProgramInfoLog(p));
      const u = {};
      const setUniformLocation = n => {u[n] = gl.getUniformLocation(p, n);}
      ['iResolution','iTime','iTimeDelta','iFrame','iMouse','iDate','iSampleRate',
       'iChannelResolution','iChannel0','iChannel1','iChannel2','iChannel3'
      ].forEach(setUniformLocation);
      controlsData.keys().forEach(setUniformLocation)
      return { program: p, u };
    }

    // ---- load a shader directory (as produced by fetch_shader.py) ------------
    async function fetchText(url){
      const r = await fetch(url);
      if (!r.ok) return null;
      return await r.text();
    }

    async function loadShaderDir(dir){
      const [common, image, a, b, c, d, configTxt] = await Promise.all([
        fetchText(`${dir}/common.glsl`),
        fetchText(`${dir}/image.glsl`),
        fetchText(`${dir}/bufferA.glsl`),
        fetchText(`${dir}/bufferB.glsl`),
        fetchText(`${dir}/bufferC.glsl`),
        fetchText(`${dir}/bufferD.glsl`),
        fetchText(`${dir}/config.json`),
      ]);
      if (image === null) fail(`${dir}/image.glsl not found — check SHADER_DIR, and that you're serving over http(s):// not file://.`);
      if (!configTxt) fail(`${dir}/config.json not found — check SHADER_DIR.`);
      return {
        common: common || '',
        bufferSrc: { A: a, B: b, C: c, D: d },
        image,
        config: JSON.parse(configTxt),
      };
    }

    // name -> PingPong, and ordered pass list; populated by start()
    let buffers = {};
    let passes = [];
    let CHANNELS = {};

    // ---- static texture loading -----------------------------------------------
    const loadedTextures = {}; // url -> {tex, w, h}
    function loadTexture(url){
      if (loadedTextures[url]) return Promise.resolve(loadedTextures[url]);
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          createImageBitmap(img, { imageOrientation: "flipY" }).then((flippedImg)=>{
              const tex = gl.createTexture();
              gl.bindTexture(gl.TEXTURE_2D, tex);
              gl.texImage2D(
                  gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, flippedImg
              );
              gl.generateMipmap(gl.TEXTURE_2D);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
              const entry = { tex, w: img.naturalWidth, h: img.naturalHeight };
              loadedTextures[url] = entry;
              resolve(entry);
          });
        };
        img.onerror = reject;
        img.src = `${shaderboxScriptSrc}/../images/${url}`;
      });
    }

    const dummyTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, dummyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,255]));

    // ---- keyboard texture --------------------------------------------------
    // Shadertoy's keyboard channel is a special 256x3 texture, state in .x:
    //   row 0 (y in [0, 1/3))   : 1 while the key is held down
    //   row 1 (y in [1/3, 2/3)) : 1 for exactly one frame, the instant it's pressed
    //   row 2 (y in [2/3, 1))   : toggles 0<->1 on each press
    // Sampled as texture(iChannelN, vec2((keyCode+.5)/256., ROW)).x — keyCode is
    // the legacy JS `keyCode` (space=32, arrows=37-40, A-Z=65-90, etc).
    const KEY_W = 256, KEY_H = 3;
    const keyDown = new Uint8Array(KEY_W);
    const keyToggle = new Uint8Array(KEY_W);
    let keyPressedThisFrame = new Set();
    let keyboardTex = null;
    const keyboardTexData = new Uint8Array(KEY_W * KEY_H * 4);

    // Keys that commonly drive shaders (space/arrows/page keys) also scroll the
    // page by default — suppress that only for those, only once the canvas/page
    // is actually being used for keyboard input.
    const KEYS_TO_GUARD = new Set([32,33,34,35,36,37,38,39,40]);

    window.addEventListener('keydown', e => {
      const code = e.keyCode;
      if (code == null || code >= KEY_W) return;
      keyDown[code] = 1;
      if (!e.repeat){
        keyToggle[code] ^= 1;
        keyPressedThisFrame.add(code);
      }
      if (KEYS_TO_GUARD.has(code)) e.preventDefault();
    });
    window.addEventListener('keyup', e => {
      const code = e.keyCode;
      if (code == null || code >= KEY_W) return;
      keyDown[code] = 0;
    });

    function ensureKeyboardTexture(){
      if (keyboardTex) return;
      keyboardTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, keyboardTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, KEY_W, KEY_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, keyboardTexData);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    function updateKeyboardTexture(){
      if (!keyboardTex) return;
      for (let c = 0; c < KEY_W; c++){
        keyboardTexData[(0*KEY_W + c)*4]                 = keyDown[c] ? 255 : 0;               // row 0: down
        keyboardTexData[(1*KEY_W + c)*4]       = keyPressedThisFrame.has(c) ? 255:0; // row 1: press pulse
        keyboardTexData[(2*KEY_W + c)*4]     = keyToggle[c] ? 255 : 0;             // row 2: toggle
      }
      gl.bindTexture(gl.TEXTURE_2D, keyboardTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, KEY_W, KEY_H, gl.RGBA, gl.UNSIGNED_BYTE, keyboardTexData);
      keyPressedThisFrame = new Set(); // "press" only holds for the frame it happened in
    }

    let frame = 0, startTime = performance.now(), lastTime = startTime;

    // ---- resize -----------------------------------------------------------
    function resize(){
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width === w && canvas.height === h) return;
      frame = 0;
      startTime = performance.now();
      lastTime = startTime;
      canvas.width = w; canvas.height = h;
      Object.values(buffers).forEach(b => b.resize(w, h));
    }
    window.addEventListener('resize', resize);

    // ---- mouse (Shadertoy iMouse convention) -------------------------------
    let mouse = { x:0, y:0, clickX:0, clickY:0, down:false };
    canvas.addEventListener('mousedown', e => {
      mouse.down = true;
      const r = canvas.getBoundingClientRect();
      mouse.clickX = mouse.x = (e.clientX - r.left) * (canvas.width / r.width);
      mouse.clickY = mouse.y = canvas.height - (e.clientY - r.top) * (canvas.height / r.height);
    });
    window.addEventListener('mousemove', e => {
      if (!mouse.down) return;
      const r = canvas.getBoundingClientRect();
      mouse.x = (e.clientX - r.left) * (canvas.width / r.width);
      mouse.y = canvas.height - (e.clientY - r.top) * (canvas.height / r.height);
    });
    window.addEventListener('mouseup', () => { mouse.down = false; });

    // ---- main loop -----------------------------------------------------------
    async function start(){
      const shader = await loadShaderDir(SHADER_DIR);
      CHANNELS = shader.config.channels || {};

      // build ping-pong buffers + compiled programs for each pass that exists
      Object.keys(shader.bufferSrc).forEach(name => {
        if (shader.bufferSrc[name]) buffers[name] = new PingPong(canvas.width || 1, canvas.height || 1);
      });
      Object.keys(shader.bufferSrc).forEach(name => {
        if (shader.bufferSrc[name]) {
          passes.push({ name: 'Buffer' + name, target: buffers[name], ...makeProgram(shader.bufferSrc[name], shader.common) });
        }
      });
      passes.push({ name: 'Image', target: null, ...makeProgram(shader.image, shader.common) });

      // preload any static textures referenced in CHANNELS; create the keyboard
      // texture only if some pass actually uses it
      const urls = new Set();
      let usesKeyboard = false;
      Object.values(CHANNELS).forEach(chs => (chs || []).forEach(c => {
        if (c && c.texture) urls.add(c.texture);
        if (c && c.keyboard) usesKeyboard = true;
      }));
      if (usesKeyboard) ensureKeyboardTexture();
      await Promise.all([...urls].map(loadTexture));

      resize();
      requestAnimationFrame(render);
    }

    function bindChannels(passName, u){
      const cfg = CHANNELS[passName] || [null,null,null,null];
      const res = [];
      cfg.forEach((c, i) => {
        gl.activeTexture(gl.TEXTURE0 + i);
        if (c && c.buffer){
          const b = buffers[c.buffer];
          gl.bindTexture(gl.TEXTURE_2D, b.front);
          res.push(b.w, b.h, 1);
        } else if (c && c.texture){
          const t = loadedTextures[c.texture];
          gl.bindTexture(gl.TEXTURE_2D, t.tex);
          res.push(t.w, t.h, 1);
        } else if (c && c.keyboard){
          gl.bindTexture(gl.TEXTURE_2D, keyboardTex);
          res.push(KEY_W, KEY_H, 1);
        } else {
          gl.bindTexture(gl.TEXTURE_2D, dummyTex);
          res.push(0,0,0);
        }
        gl.uniform1i(u['iChannel'+i], i);
      });
      gl.uniform3fv(u.iChannelResolution, res);
    }

    function render(now){
      resize();
      updateKeyboardTexture();
      const t = (now - startTime) / 1000;
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      const date = new Date();
      const secs = date.getHours()*3600 + date.getMinutes()*60 + date.getSeconds() + date.getMilliseconds()/1000;

      passes.forEach(pass => {
        const w = pass.target ? pass.target.w : canvas.width;
        const h = pass.target ? pass.target.h : canvas.height;
        gl.bindFramebuffer(gl.FRAMEBUFFER, pass.target ? pass.target.backFBO : null);
        gl.viewport(0, 0, w, h);
        gl.useProgram(pass.program);

        gl.uniform3f(pass.u.iResolution, w, h, 1);
        gl.uniform1f(pass.u.iTime, t);
        gl.uniform1f(pass.u.iTimeDelta, dt);
        gl.uniform1i(pass.u.iFrame, frame);
        gl.uniform4f(pass.u.iMouse, mouse.x, mouse.y,
          mouse.down ? mouse.clickX : -mouse.clickX,
          mouse.down ? mouse.clickY : -mouse.clickY);
        gl.uniform4f(pass.u.iDate, date.getFullYear(), date.getMonth()+1, date.getDate(), secs);
        gl.uniform1f(pass.u.iSampleRate, 44100);

        controlsData.forEach((value, key) => {
            gl.uniform1f(pass.u[key], parseFloat(value));
        });

        bindChannels(pass.name, pass.u);

        gl.drawArrays(gl.TRIANGLES, 0, 3);

        if (pass.target) pass.target.swap();
      });

      frame++;
      requestAnimationFrame(render);
    }

    start().catch(e => fail(String(e)));
}

function instantiateAllShaders() {
    document.querySelectorAll(".shaderbox").forEach(instantiateShader);
}

const shaderboxCss = document.createElement("link");
shaderboxCss.rel = "stylesheet";
shaderboxCss.href = `${document.currentScript.src}/../shaderbox.css`;
document.head.appendChild(shaderboxCss);

instantiateAllShaders();
