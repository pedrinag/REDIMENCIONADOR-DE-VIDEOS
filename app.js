import {
  Input, Output, ALL_FORMATS, BlobSource, BufferTarget, Mp4OutputFormat, canEncodeAudio,
  VideoSample, VideoSampleSink, VideoSampleSource,
  EncodedPacketSink, EncodedAudioPacketSource, AudioSampleSink, AudioSampleSource,
} from './vendor/mediabunny.min.mjs';

// Formatos aceitos pelo Gerenciador de Anúncios da Meta
const FORMATS = {
  '9x16': { label: '9:16', name: 'Story/Reels', w: 1080, h: 1920 },
  '4x5':  { label: '4:5',  name: 'Feed',        w: 1080, h: 1350 },
  '1x1':  { label: '1:1',  name: 'Quadrado',    w: 1080, h: 1080 },
  '16x9': { label: '16:9', name: 'Paisagem',    w: 1920, h: 1080 },
};
// Até ~7% de diferença o modo automático corta uma borda fina; acima disso usa fundo desfocado
const CROP_TOLERANCE = 0.07;
// A placa de vídeo satura com 3 a 4 codificações simultâneas
const CONCURRENCY = 3;

const $ = (s) => document.querySelector(s);
const grid = $('#grid');
const items = [];
const busy = () => active > 0 || queue.length > 0;

if (typeof VideoEncoder === 'undefined') {
  const n = $('#notice');
  n.style.display = 'block';
  n.textContent = 'Seu navegador não suporta codificação de vídeo (WebCodecs). Use Google Chrome ou Microsoft Edge atualizados.';
}

// ---------- entrada de arquivos ----------
const drop = $('#drop');
$('#files').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  addFiles(e.dataTransfer.files);
});

function addFiles(list) {
  for (const file of list) {
    if (!file.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name)) continue;
    const item = {
      id: crypto.randomUUID(), file, w: 0, h: 0, duration: 0,
      formats: new Set(), suggested: null, mode: $('#allMode').value,
      frame: null, previewKey: null, outputs: [], status: 'Lendo vídeo…', state: 'loading', progress: 0,
    };
    items.push(item);
    renderCard(item);
    loadMeta(item);
  }
  refresh();
}

function loadMeta(item) {
  const url = URL.createObjectURL(item.file);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.src = url;
  v.addEventListener('loadedmetadata', () => {
    item.w = v.videoWidth;
    item.h = v.videoHeight;
    item.duration = v.duration;
    item.suggested = suggest(item.w / item.h);
    const all = $('#allFormat').value;
    applyFormatChoice(item, all && all !== '' ? all : 'auto');
    item.state = 'ready';
    item.status = 'Pronto para converter';
    if ($('#auto').checked) enqueue(item);
    else updateCard(item);
    v.currentTime = Math.min(1, (v.duration || 2) / 3);
  }, { once: true });
  v.addEventListener('seeked', () => {
    const c = document.createElement('canvas');
    const scale = Math.min(1, 640 / Math.max(item.w, item.h));
    c.width = Math.round(item.w * scale);
    c.height = Math.round(item.h * scale);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    item.frame = c;
    URL.revokeObjectURL(url);
    v.removeAttribute('src');
    updateCard(item);
  }, { once: true });
  v.addEventListener('error', () => {
    item.state = 'error';
    item.status = 'Não foi possível ler este vídeo';
    updateCard(item);
    refresh();
  }, { once: true });
}

// ---------- lógica de proporção ----------
function suggest(ratio) {
  let best = null, bestDiff = Infinity;
  for (const [key, f] of Object.entries(FORMATS)) {
    const d = Math.abs(Math.log(ratio / (f.w / f.h)));
    if (d < bestDiff) { bestDiff = d; best = key; }
  }
  return best;
}

function ratioDiff(item, key) {
  const f = FORMATS[key];
  return Math.abs(Math.log((item.w / item.h) / (f.w / f.h)));
}

function resolveMode(item, key) {
  if (item.mode !== 'auto') return item.mode;
  return ratioDiff(item, key) <= CROP_TOLERANCE ? 'cover' : 'blur';
}

function applyFormatChoice(item, choice) {
  item.formats.clear();
  if (choice === 'auto') item.formats.add(item.suggested);
  else if (choice === 'feedstory') { item.formats.add('9x16'); item.formats.add('4x5'); }
  else item.formats.add(choice);
  item.previewKey = [...item.formats][0];
}

function prettyRatio(w, h) {
  const r = w / h;
  return r >= 1 ? `${r.toFixed(2).replace('.', ',')}:1` : `1:${(1 / r).toFixed(2).replace('.', ',')}`;
}

// Desenha a fonte (frame da prévia ou VideoSample) no quadro de destino sem distorcer
function compose(ctx, W, H, sw, sh, mode, draw, blurCanvas) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (mode === 'cover') {
    const s = Math.max(W / sw, H / sh);
    const dw = sw * s, dh = sh * s;
    draw(ctx, (W - dw) / 2, (H - dh) / 2, dw, dh);
    return;
  }
  if (mode === 'blur') {
    // desfoca numa versão pequena (rápido) e amplia para o fundo
    const bctx = blurCanvas.getContext('2d');
    const bw = blurCanvas.width, bh = blurCanvas.height;
    const s = Math.max(bw / sw, bh / sh) * 1.15;
    const dw = sw * s, dh = sh * s;
    bctx.filter = `blur(${Math.max(2, Math.round(bw / 40))}px)`;
    draw(bctx, (bw - dw) / 2, (bh - dh) / 2, dw, dh);
    bctx.filter = 'none';
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(blurCanvas, -W * 0.03, -H * 0.03, W * 1.06, H * 1.06);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(0, 0, W, H);
  }
  const s = Math.min(W / sw, H / sh);
  const dw = Math.round(sw * s), dh = Math.round(sh * s);
  draw(ctx, Math.round((W - dw) / 2), Math.round((H - dh) / 2), dw, dh);
}

function makeBlurCanvas(W, H) {
  const c = new OffscreenCanvas(Math.max(16, Math.round(W / 8)), Math.max(16, Math.round(H / 8)));
  return c;
}

// ---------- cards ----------
function renderCard(item) {
  const el = document.createElement('div');
  el.className = 'card';
  el.id = 'c-' + item.id;
  el.innerHTML = `
    <div class="preview">
      <canvas></canvas>
      <span class="tag"></span>
      <button class="remove" title="Remover">✕</button>
    </div>
    <div class="body">
      <div>
        <div class="name"></div>
        <div class="meta"></div>
      </div>
      <div class="chips"></div>
      <div class="row">
        <select class="mode">
          <option value="auto">Encaixe automático</option>
          <option value="blur">Fundo desfocado</option>
          <option value="black">Barras pretas</option>
          <option value="cover">Cortar para preencher</option>
        </select>
      </div>
      <div class="hint"></div>
      <div class="bar"><i></i></div>
      <div class="status"></div>
      <div class="downloads"></div>
    </div>`;
  el.querySelector('.name').textContent = item.file.name;
  el.querySelector('.name').title = item.file.name;
  el.querySelector('.mode').value = item.mode;
  el.querySelector('.mode').addEventListener('change', (e) => {
    item.mode = e.target.value;
    invalidate(item);
  });
  el.querySelector('.remove').addEventListener('click', () => {
    if (item.state === 'working') return;
    items.splice(items.indexOf(item), 1);
    item.outputs.forEach((o) => URL.revokeObjectURL(o.url));
    el.remove();
    refresh();
  });
  const chips = el.querySelector('.chips');
  for (const [key, f] of Object.entries(FORMATS)) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.key = key;
    b.addEventListener('click', () => {
      if (item.state === 'working' || !item.w) return;
      if (item.formats.has(key) && item.previewKey !== key) {
        item.previewKey = key;
      } else if (item.formats.has(key)) {
        if (item.formats.size > 1) {
          item.formats.delete(key);
          item.previewKey = [...item.formats][0];
        }
      } else {
        item.formats.add(key);
        item.previewKey = key;
      }
      invalidate(item);
    });
    b.title = `${f.name} · ${f.w}×${f.h}`;
    chips.appendChild(b);
  }
  grid.appendChild(el);
  updateCard(item);
}

function invalidate(item) {
  if (item.state === 'done') {
    item.state = 'ready';
    item.status = 'Configuração mudou, converta de novo';
  }
  updateCard(item);
  if (item.state === 'ready' && $('#auto').checked) enqueue(item);
  refresh();
}

function updateCard(item) {
  const el = document.getElementById('c-' + item.id);
  if (!el) return;
  const meta = el.querySelector('.meta');
  if (item.w) {
    const sug = FORMATS[item.suggested];
    const exact = ratioDiff(item, item.suggested) < 0.005;
    meta.innerHTML = `${item.w}×${item.h} · ${prettyRatio(item.w, item.h)} · ${fmtTime(item.duration)}<br>`
      + (exact
        ? `<b class="good">Já está em ${sug.label}</b> — vai ser reprocessado limpo`
        : `<b>Fora do padrão</b> — sugerido ${sug.label} ${sug.name}`);
  } else {
    meta.textContent = fmtSize(item.file.size);
  }
  el.querySelectorAll('.chip').forEach((b) => {
    const key = b.dataset.key;
    const on = item.formats.has(key);
    b.className = 'chip' + (on ? ' on' : '');
    b.innerHTML = FORMATS[key].label + (key === item.suggested ? '<span class="star">★</span>' : '');
    b.style.outline = on && key === item.previewKey && item.formats.size > 1 ? '1px solid var(--accent-2)' : '';
  });
  el.querySelector('.mode').value = item.mode;

  const hint = el.querySelector('.hint');
  if (item.w && item.previewKey) {
    const m = resolveMode(item, item.previewKey);
    const pct = Math.round((1 - Math.exp(-ratioDiff(item, item.previewKey))) * 100);
    hint.textContent = m === 'cover'
      ? (pct === 0 ? 'Mesma proporção: só redimensiona, nada cortado.' : `Corta ~${pct}% das bordas para preencher.`)
      : m === 'blur' ? 'Vídeo inteiro sobre fundo desfocado, sem cortes.' : 'Vídeo inteiro com barras pretas, sem cortes.';
  } else hint.textContent = '';

  el.querySelector('.tag').textContent = item.previewKey ? `${FORMATS[item.previewKey].label} · ${FORMATS[item.previewKey].w}×${FORMATS[item.previewKey].h}` : '';
  drawPreview(item, el.querySelector('canvas'));

  el.querySelector('.bar > i').style.width = Math.round(item.progress * 100) + '%';
  const st = el.querySelector('.status');
  st.textContent = item.status;
  st.className = 'status' + (item.state === 'done' ? ' ok' : item.state === 'error' ? ' err' : '');

  const dl = el.querySelector('.downloads');
  dl.innerHTML = '';
  if (item.state === 'done') {
    for (const o of item.outputs) {
      const a = document.createElement('a');
      a.href = o.url;
      a.download = o.name;
      a.textContent = `⬇ ${FORMATS[o.key].label} · ${fmtSize(o.blob.size)}`;
      dl.appendChild(a);
    }
  }
}

function drawPreview(item, canvas) {
  if (!item.frame || !item.previewKey) return;
  const f = FORMATS[item.previewKey];
  const H = 200, W = Math.round(H * f.w / f.h);
  canvas.width = W * 2;
  canvas.height = H * 2;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  const src = item.frame;
  compose(ctx, canvas.width, canvas.height, src.width, src.height, resolveMode(item, item.previewKey),
    (c, x, y, w, h) => c.drawImage(src, x, y, w, h), makeBlurCanvas(canvas.width, canvas.height));
}

// ---------- conversão ----------
function bitrateFor(f) {
  const base = $('#quality').value === 'max' ? 12e6 : 8e6;
  return Math.round(base * (f.w * f.h) / (1080 * 1920));
}

// Decodifica o vídeo uma única vez e codifica todos os formatos escolhidos ao mesmo tempo
async function convert(item, keys, onProgress) {
  const input = new Input({ source: new BlobSource(item.file), formats: ALL_FORMATS });
  const vTrack = await input.getPrimaryVideoTrack();
  if (!vTrack || !(await vTrack.canDecode())) throw new Error('Formato de vídeo não suportado neste navegador');
  const aTrack = await input.getPrimaryAudioTrack();
  const duration = (await input.computeDuration()) || item.duration || 1;

  let audioMode = null, audioConfig = null;
  if (aTrack) {
    if (aTrack.codec === 'aac') {
      audioMode = 'copy';
      audioConfig = await aTrack.getDecoderConfig();
    } else if ((await aTrack.canDecode()) && (await canEncodeAudio('aac'))) {
      audioMode = 'encode';
    }
  }

  const targets = keys.map((key) => {
    const f = FORMATS[key];
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const video = new VideoSampleSource({
      codec: 'avc', bitrate: bitrateFor(f), hardwareAcceleration: 'prefer-hardware',
    });
    output.addVideoTrack(video);
    let audio = null;
    if (audioMode === 'copy') audio = new EncodedAudioPacketSource('aac');
    if (audioMode === 'encode') audio = new AudioSampleSource({ codec: 'aac', bitrate: 192e3 });
    if (audio) output.addAudioTrack(audio);
    const canvas = new OffscreenCanvas(f.w, f.h);
    return {
      key, f, output, video, audio, canvas,
      ctx: canvas.getContext('2d', { alpha: false }),
      blur: makeBlurCanvas(f.w, f.h),
      mode: resolveMode(item, key),
    };
  });
  await Promise.all(targets.map((t) => t.output.start()));

  const maxFps = Number($('#fps').value);
  const minGap = maxFps ? 1 / maxFps - 0.008 : 0;

  const videoJob = (async () => {
    let next = -Infinity;
    for await (const sample of new VideoSampleSink(vTrack).samples()) {
      const ts = sample.timestamp;
      if (ts < next) { sample.close(); continue; }
      next = ts + minGap;
      const dur = maxFps ? Math.max(sample.duration, 1 / maxFps) : sample.duration;
      await Promise.all(targets.map((t) => {
        compose(t.ctx, t.f.w, t.f.h, sample.displayWidth, sample.displayHeight, t.mode,
          (c, x, y, w, h) => sample.draw(c, x, y, w, h), t.blur);
        const out = new VideoSample(t.canvas, { timestamp: ts, duration: dur });
        return t.video.add(out).finally(() => out.close());
      }));
      sample.close();
      onProgress(Math.min(1, ts / duration));
    }
    targets.forEach((t) => t.video.close());
  })();

  const audioJob = (async () => {
    if (audioMode === 'copy') {
      let first = true;
      for await (const packet of new EncodedPacketSink(aTrack).packets()) {
        const meta = first ? { decoderConfig: audioConfig } : undefined;
        first = false;
        await Promise.all(targets.map((t) => t.audio.add(packet, meta)));
      }
    } else if (audioMode === 'encode') {
      for await (const sample of new AudioSampleSink(aTrack).samples()) {
        await Promise.all(targets.map((t) => t.audio.add(sample)));
        sample.close();
      }
    }
    targets.forEach((t) => t.audio?.close());
  })();

  await Promise.all([videoJob, audioJob]);
  await Promise.all(targets.map((t) => t.output.finalize()));
  return {
    audioDropped: !!aTrack && !audioMode,
    results: targets.map((t) => ({ key: t.key, blob: new Blob([t.output.target.buffer], { type: 'video/mp4' }) })),
  };
}

// ---------- fila contínua ----------
const queue = [];
let active = 0;

function enqueue(item) {
  if (!item.w || !item.formats.size) return;
  if (item.state === 'queued' || item.state === 'working') return;
  item.outputs.forEach((o) => URL.revokeObjectURL(o.url));
  item.outputs = [];
  item.state = 'queued';
  item.status = 'Na fila…';
  item.progress = 0;
  queue.push(item);
  updateCard(item);
  pump();
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const item = queue.shift();
    if (!items.includes(item)) continue;
    active++;
    processItem(item).finally(() => { active--; pump(); refresh(); });
  }
  refresh();
}

async function processItem(item) {
  const keys = ORDER.filter((k) => item.formats.has(k));
  item.state = 'working';
  item.status = `Convertendo ${keys.map((k) => FORMATS[k].label).join(' + ')}…`;
  updateCard(item);
  const t0 = performance.now();
  try {
    const { results, audioDropped } = await convert(item, keys, (p) => {
      item.progress = p;
      const el = document.getElementById('c-' + item.id);
      if (el) el.querySelector('.bar > i').style.width = Math.round(p * 100) + '%';
    });
    const base = item.file.name.replace(/\.[^.]+$/, '');
    item.outputs = results.map((r) => ({ ...r, name: `${base}_${r.key}.mp4`, url: URL.createObjectURL(r.blob) }));
    item.state = 'done';
    item.progress = 1;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    item.status = audioDropped ? `Pronto em ${secs}s (áudio não pôde ser convertido neste navegador)` : `Pronto ✓ em ${secs}s`;
  } catch (err) {
    console.error(err);
    item.state = 'error';
    item.status = 'Erro: ' + (err.message || String(err));
  }
  updateCard(item);
}

function runAll() {
  for (const item of items) if (item.state === 'ready' || item.state === 'error') enqueue(item);
}
const ORDER = Object.keys(FORMATS);

// ---------- toolbar ----------
$('#run').addEventListener('click', runAll);
$('#allFormat').addEventListener('change', (e) => {
  if (!e.target.value) return;
  for (const item of items) {
    if (!item.w || item.state === 'working' || item.state === 'queued') continue;
    applyFormatChoice(item, e.target.value);
    invalidate(item);
  }
});
$('#allMode').addEventListener('change', (e) => {
  for (const item of items) {
    if (item.state === 'working' || item.state === 'queued') continue;
    item.mode = e.target.value;
    invalidate(item);
  }
});
$('#quality').addEventListener('change', () => items.forEach((i) => { if (i.state === 'done') invalidate(i); }));
$('#clear').addEventListener('click', () => {
  if (busy()) return;
  for (const item of items) item.outputs.forEach((o) => URL.revokeObjectURL(o.url));
  items.length = 0;
  grid.innerHTML = '';
  refresh();
});
$('#zip').addEventListener('click', async () => {
  const files = items.flatMap((i) => i.outputs).map((o) => ({ name: o.name, blob: o.blob }));
  if (!files.length) return;
  const btn = $('#zip');
  btn.disabled = true;
  btn.textContent = 'Gerando zip…';
  const zip = await makeZip(files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zip);
  a.download = 'videos-redimensionados.zip';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  btn.textContent = 'Baixar tudo (.zip)';
  refresh();
});

function refresh() {
  const ready = items.filter((i) => (i.state === 'ready' || i.state === 'error') && i.w).length;
  const outs = items.reduce((n, i) => n + i.outputs.length, 0);
  const left = items.filter((i) => i.state === 'queued' || i.state === 'working').length;
  $('#run').disabled = !ready;
  $('#run').textContent = left && !ready ? `Convertendo… (${left})` : `Converter tudo${ready ? ` (${ready})` : ''}`;
  $('#zip').disabled = !outs;
  $('#clear').disabled = busy();
  $('#empty').style.display = items.length ? 'none' : 'block';
  $('#stats').textContent = items.length ? `${items.length} vídeo(s) · ${outs} arquivo(s) pronto(s)` : '';
}

function fmtSize(b) {
  return b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB';
}
function fmtTime(s) {
  if (!isFinite(s)) return '';
  s = Math.round(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- zip simples (sem compressão, vídeo já é comprimido) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  let offset = 0;
  const used = new Set();
  for (const f of files) {
    let name = f.name, n = 1;
    while (used.has(name)) name = f.name.replace(/\.mp4$/, `_${++n}.mp4`);
    used.add(name);
    const nameBytes = enc.encode(name);
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(local, nameBytes, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

refresh();
