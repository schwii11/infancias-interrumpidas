const $ = (selector) => document.querySelector(selector);
const video = $('#sourceVideo');
const canvas = $('#analysisCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const scoreCanvas = $('#scoreCanvas');
const scoreCtx = scoreCanvas.getContext('2d');
const waveCanvas = $('#waveCanvas');
const waveCtx = waveCanvas.getContext('2d');
const controls = {
  pixelThreshold: $('#pixelThreshold'), zoneSensitivity: $('#zoneSensitivity'),
  cooldown: $('#cooldown'), masterVolume: $('#masterVolume'),
  gameVolume: $('#gameVolume'), boxVolume: $('#boxVolume'), breathVolume: $('#breathVolume'), voiceVolume: $('#voiceVolume'),
  volumeMapping: $('#volumeMapping'), panMapping: $('#panMapping'), spectrumMapping: $('#spectrumMapping'),
  envelopeMapping: $('#envelopeMapping'), distortionMapping: $('#distortionMapping'), distortionAmount: $('#distortionAmount'),
  loopVideo: $('#loopVideo')
};
// Primera selección de cortes. Ajustar start/end después de revisar el montaje en pantalla.
const segments = [
  { src: 'assets/video/01-correr.mp4', start: 0, end: 14, kind: 'juego' },
  { src: 'assets/video/02-interrupcion.mp4', start: 0, end: 14, kind: 'caja' },
  { src: 'assets/video/03-agua.mp4', start: 0, end: 12, kind: 'respiracion' },
  { src: 'assets/video/04-humo.mp4', start: 0, end: 15, kind: 'respiracion' },
  { src: 'assets/video/05-rostro.mp4', start: 0, end: 8, kind: 'voz' },
  { src: 'assets/video/06-ausencia.mp4', start: 0, end: 14, kind: 'voz' }
];
let sounds = {
  juego: ['risas-nina.ogg'],
  respiracion: ['respiracion-agitada-01.ogg', 'respiracion-agitada-02.ogg', 'respiracion-agitada-03.ogg'],
  voz: ['mama.ogg', 'mama-donde-estas.ogg'],
  caja: ['caja-musical-generada']
};
const labels = { juego: 'juego', caja: 'caja musical', respiracion: 'respiración', voz: 'voz distante' };
const stageRules = [
  { sound: 'Risa infantil', rule: 'Cuando la cuadrícula detecta movimiento en la escena de correr.' },
  { sound: 'Caja musical', rule: 'Al comenzar la escena de interrupción; continúa mientras ese tramo está activo.' },
  { sound: 'Respiraciones', rule: 'Cuando el movimiento del agua, las personas y el humo modifica la cuadrícula.' },
  { sound: 'Respiraciones', rule: 'Cuando la cuadrícula detecta movimiento entre el humo.' },
  { sound: 'Voces infantiles', rule: 'La presencia del rostro infantil conecta la imagen con las voces del banco sonoro.' },
  { sound: 'Voces infantiles', rule: '“Mamá” aparece con la quietud; un cambio intenso activa “¿dónde estás?”.' }
];
const fileLabels = {
  'risas-nina.ogg': 'risa infantil', 'caja-musical-generada': 'caja musical generada',
  'respiracion-agitada-01.ogg': 'respiración 01', 'respiracion-agitada-02.ogg': 'respiración 02',
  'respiracion-agitada-03.ogg': 'respiración 03', 'mama.ogg': '“mamá”',
  'mama-donde-estas.ogg': '“mamá, ¿dónde estás?”'
};
// Compensación de escucha calculada a partir del nivel medio de cada archivo.
// No modifica los originales: solo equilibra su ganancia durante la reproducción.
const fileGainCompensation = {
  'risas-nina.ogg': 1.12,
  'caja-musical-generada': 1.12,
  'respiracion-agitada-01.ogg': 1.17,
  'respiracion-agitada-02.ogg': 1.15,
  'respiracion-agitada-03.ogg': 1.19,
  'mama.ogg': 1.42,
  'mama-donde-estas.ogg': 1.48
};
// Paleta inspirada en lápices, bloques y juguetes infantiles. El archivo se
// mantiene sobrio; el color aparece únicamente donde la imagen activa sonido.
const colors = { juego: '#b9e4d0', caja: '#f4c6d7', respiracion: '#bbddf2', voz: '#d7c7f0' };
const rgbColors = {
  juego: [185, 228, 208],
  caja: [244, 198, 215],
  respiracion: [187, 221, 242],
  voz: [215, 199, 240]
};
function getZoneColors() {
  const currentKind = segments[currentSegment]?.kind || 'juego';
  const base = rgbColors[currentKind] || rgbColors.juego;
  return Array.from({ length: 12 }, () => base);
}
const envelopes = {
  juego: { attack: .05, decay: .18, sustain: .78, release: .25 },
  caja: { attack: .02, decay: .1, sustain: .72, release: .08 },
  respiracion: { attack: .45, decay: .3, sustain: .9, release: .8 },
  voz: { attack: .1, decay: .25, sustain: .95, release: 1.6 }
};
const distortionByKind = { juego: 0, caja: .75, respiracion: 1, voz: .35 };
const quietIntervals = { juego: 4800, caja: 5200, respiracion: 3400, voz: 4200 };
const audioBuffers = new Map();
const events = [];
const lastTrigger = new Array(12).fill(0);
let audioContext, masterGain, analyser, previousFrame;
let lastActivity = performance.now();
let globalLastTrigger = 0;
let activeNormalVoices = 0, activeBoxVoices = 0, activeVoiceLayers = 0;
let running = false, muted = false, animationStarted = false;
let currentSegment = 0, segmentReady = false;

function createMusicBoxBuffer() {
  const sampleRate = audioContext.sampleRate;
  const duration = 3.4;
  const buffer = audioContext.createBuffer(1, Math.floor(sampleRate * duration), sampleRate);
  const output = buffer.getChannelData(0);
  const notes = [523.25, 659.25, 783.99, 659.25, 587.33, 698.46, 880, 698.46];
  const spacing = .38;
  for (let index = 0; index < output.length; index += 1) {
    const time = index / sampleRate;
    let sample = 0;
    notes.forEach((frequency, noteIndex) => {
      const localTime = time - noteIndex * spacing;
      if (localTime < 0 || localTime > 1.15) return;
      const attack = Math.min(1, localTime / .008);
      const decay = Math.exp(-4.8 * localTime);
      sample += attack * decay * (
        Math.sin(2 * Math.PI * frequency * localTime) * .72 +
        Math.sin(2 * Math.PI * frequency * 2.01 * localTime) * .2 +
        Math.sin(2 * Math.PI * frequency * 3.98 * localTime) * .08
      );
    });
    output[index] = Math.max(-1, Math.min(1, sample * .55));
  }
  return buffer;
}

function loadSegment(index, keepPlaying = running) {
  currentSegment = (index + segments.length) % segments.length;
  const segment = segments[currentSegment]; segmentReady = false; previousFrame = null; lastActivity = performance.now();
  const sameSource = video.getAttribute('src') === segment.src;
  if (!sameSource) { video.src = segment.src; video.load(); }
  const prepare = async () => {
    video.currentTime = segment.start; segmentReady = true; updateTimeline();
    if (keepPlaying) { try { await video.play(); } catch (error) { console.warn(error); } }
    if (keepPlaying && audioContext) {
      setTimeout(() => triggerSound(segment.kind, segment.kind === 'caja' ? .72 : .44, 5), 220);
    }
  };
  if (sameSource && video.readyState >= 1) prepare(); else video.addEventListener('loadedmetadata', prepare, { once: true });
  $('#statusText').textContent = `Tramo ${currentSegment + 1} preparado`;
}

async function initAudio() {
  if (audioContext) return;
  audioContext = new AudioContext(); masterGain = audioContext.createGain();
  analyser = audioContext.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = .72;
  masterGain.gain.value = Number(controls.masterVolume.value) / 100;
  masterGain.connect(analyser).connect(audioContext.destination); $('#statusText').textContent = 'Cargando banco sonoro';
  const files = [...new Set(Object.values(sounds).flat())];
  await Promise.all(files.map(async (file) => {
    try {
      if (file === 'caja-musical-generada') {
        audioBuffers.set(file, createMusicBoxBuffer());
        return;
      }
      const response = await fetch(`assets/audio/${file}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      audioBuffers.set(file, await audioContext.decodeAudioData(await response.arrayBuffer()));
    } catch (error) { console.warn(`No se pudo cargar ${file}`, error); }
  }));
}

function makeDistortionCurve(amount = 0) {
  const samples = 256; const curve = new Float32Array(samples);
  const strength = Math.max(0, amount);
  for (let index = 0; index < samples; index += 1) {
    const x = index * 2 / (samples - 1) - 1;
    curve[index] = strength === 0 ? x : ((3 + strength) * x * 20 * Math.PI / 180) / (Math.PI + strength * Math.abs(x));
  }
  return curve;
}

function drawWaveform() {
  const width = waveCanvas.width, height = waveCanvas.height;
  waveCtx.clearRect(0, 0, width, height);
  waveCtx.strokeStyle = 'rgba(233,228,216,.14)'; waveCtx.beginPath();
  waveCtx.moveTo(0, height / 2); waveCtx.lineTo(width, height / 2); waveCtx.stroke();
  if (!analyser) return;
  const data = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(data);
  waveCtx.strokeStyle = colors[getStage().kind]; waveCtx.lineWidth = 2; waveCtx.beginPath();
  data.forEach((value, index) => {
    const x = index / (data.length - 1) * width; const y = value / 255 * height;
    if (index === 0) waveCtx.moveTo(x, y); else waveCtx.lineTo(x, y);
  });
  waveCtx.stroke();
}

function triggerSound(kind, amount, zone) {
  if (!audioContext || muted) return;
  const files = sounds[kind].filter((fileName) => enabledSoundFiles.has(fileName));
  if (!files.length) { $('#soundReadout').textContent = `${labels[kind]} desactivado`; return; }
  let file;
  if (kind === 'voz') {
    const isFinalSegment = currentSegment === segments.length - 1;
    const isFirstVoiceSegment = currentSegment === segments.length - 2;
    if (isFinalSegment && files.includes('mama-donde-estas.ogg')) file = 'mama-donde-estas.ogg';
    else if (isFirstVoiceSegment && files.includes('mama.ogg')) file = 'mama.ogg';
    else file = amount > .45 && files.includes('mama-donde-estas.ogg')
      ? 'mama-donde-estas.ogg'
      : (files.includes('mama.ogg') ? 'mama.ogg' : files[0]);
  } else file = files[Math.floor(Math.random() * files.length)];
  const buffer = audioBuffers.get(file); if (!buffer) return;
  if (kind !== 'voz' && kind !== 'caja' && activeNormalVoices >= 3) return;
  if (kind === 'caja' && activeBoxVoices > 0) return;
  if (kind === 'voz' && activeVoiceLayers >= 3) return;
  const source = audioContext.createBufferSource(); const gain = audioContext.createGain();
  const pan = audioContext.createStereoPanner(); const filter = audioContext.createBiquadFilter();
  const shaper = audioContext.createWaveShaper(); source.buffer = buffer;
  const row = Math.floor(zone / 4);
  source.playbackRate.value = 1;
  if (controls.spectrumMapping.checked && row === 0) { filter.type = 'highpass'; filter.frequency.value = kind === 'voz' ? 220 : 650 + amount * 850; }
  else if (controls.spectrumMapping.checked && row === 2) { filter.type = 'lowpass'; filter.frequency.value = kind === 'voz' ? 4200 : 1800 - amount * 900; }
  else { filter.type = 'allpass'; filter.frequency.value = 1000; }
  filter.Q.value = .72;
  const distortion = controls.distortionMapping.checked
    ? Number(controls.distortionAmount.value) / 100 * distortionByKind[kind] * amount * 18
    : 0;
  shaper.curve = makeDistortionCurve(distortion); shaper.oversample = '2x';
  const savedVolumes = JSON.parse(localStorage.getItem('infancias-audio-volumes') || '{}');
  const fileVolume = Number(savedVolumes[file] || 100) / 100 * (fileGainCompensation[file] || 1);
  const mappedGain = controls.volumeMapping.checked ? Math.min(1, 0.34 + amount * 0.66) : 0.74;
  const groupVolume = { juego: controls.gameVolume, caja: controls.boxVolume, respiracion: controls.breathVolume, voz: controls.voiceVolume }[kind];
  const peakGain = Math.min(1.1, mappedGain * fileVolume * (Number(groupVolume.value) / 100));
  const envelope = envelopes[kind]; const startAt = audioContext.currentTime;
  if (controls.envelopeMapping.checked) {
    const release = Math.min(envelope.release, Math.max(.04, buffer.duration * .35));
    const releaseAt = startAt + Math.max(envelope.attack + envelope.decay, buffer.duration - release);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.linearRampToValueAtTime(peakGain, startAt + envelope.attack);
    gain.gain.linearRampToValueAtTime(peakGain * envelope.sustain, startAt + envelope.attack + envelope.decay);
    gain.gain.setValueAtTime(peakGain * envelope.sustain, releaseAt);
    gain.gain.linearRampToValueAtTime(0.0001, releaseAt + release);
  } else gain.gain.setValueAtTime(peakGain, startAt);
  pan.pan.value = controls.panMapping.checked ? ((zone % 4) / 3) * 2 - 1 : 0;
  source.connect(filter).connect(shaper).connect(gain).connect(pan).connect(masterGain);
  if (kind === 'voz') {
    activeVoiceLayers += 1;
    source.addEventListener('ended', () => { activeVoiceLayers = Math.max(0, activeVoiceLayers - 1); });
  } else if (kind === 'caja') {
    activeBoxVoices += 1;
    source.addEventListener('ended', () => { activeBoxVoices = Math.max(0, activeBoxVoices - 1); });
  } else {
    activeNormalVoices += 1;
    source.addEventListener('ended', () => { activeNormalVoices = Math.max(0, activeNormalVoices - 1); });
  }
  source.start();
  globalLastTrigger = performance.now();
  const spectrumLabel = controls.spectrumMapping.checked ? [' · solo agudos', ' · espectro completo', ' · solo graves'][row] : '';
  const distortionLabel = distortion > 1 ? ' · onda deformada' : '';
  $('#soundReadout').textContent = `${fileLabels[file] || labels[kind]}${spectrumLabel}${distortionLabel}`; events.push({ time: performance.now(), zone, kind, amount });
  const soundChoice = document.querySelector(`[data-file="${file}"]`);
  if (soundChoice) {
    soundChoice.classList.remove('just-played');
    void soundChoice.offsetWidth;
    soundChoice.classList.add('just-played');
    setTimeout(() => soundChoice.classList.remove('just-played'), 900);
  }
}

function getStage() {
  return { index: currentSegment, kind: segments[currentSegment].kind };
}

function getStageMix() {
  const segment = segments[currentSegment];
  const progress = segmentReady ? Math.max(0, Math.min(1, (video.currentTime - segment.start) / (segment.end - segment.start))) : 0;
  const next = segments[currentSegment + 1];
  const fade = next && progress > .72 ? (progress - .72) / .28 : 0;
  return { primary: segment.kind, secondary: next?.kind, fade };
}

function updateTimeline() {
  $('#stageSelect').value = String(currentSegment);
  const rule = stageRules[currentSegment];
  const activeRule = $('#activeRule');
  activeRule.querySelector('strong').textContent = rule.sound;
  activeRule.querySelector('small').textContent = rule.rule;
  document.querySelectorAll('.sound-choice[data-kind]').forEach((choice) => {
    choice.classList.toggle('available-now', choice.dataset.kind === segments[currentSegment].kind);
  });
  const envelope = envelopes[segments[currentSegment].kind];
  $('#adsrReadout').textContent = `ADSR actual: ataque ${String(envelope.attack).replace('.', ',')} s · caída ${String(envelope.decay).replace('.', ',')} s · sostén ${Math.round(envelope.sustain * 100)}% · salida ${String(envelope.release).replace('.', ',')} s.`;
}

function resizeAnalysis() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(480, Math.floor(rect.width / 2));
  canvas.height = Math.max(270, Math.floor(rect.height / 2)); previousFrame = null;
}

function drawScore(now) {
  const width = scoreCanvas.width, height = scoreCanvas.height, windowMs = 10000;
  scoreCtx.clearRect(0, 0, width, height); scoreCtx.strokeStyle = 'rgba(233,228,216,.15)';
  for (let row = 0; row <= 3; row += 1) {
    const y = 20 + row * ((height - 40) / 3); scoreCtx.beginPath();
    scoreCtx.moveTo(0, y); scoreCtx.lineTo(width, y); scoreCtx.stroke();
  }
  while (events.length && now - events[0].time > windowMs) events.shift();
  for (const event of events) {
    const age = now - event.time; const x = width - (age / windowMs) * width;
    const row = Math.floor(event.zone / 4); const y = 20 + row * ((height - 40) / 3);
    scoreCtx.fillStyle = colors[event.kind]; scoreCtx.globalAlpha = Math.max(0.2, 1 - age / windowMs);
    scoreCtx.beginPath(); scoreCtx.arc(x, y, 3 + event.amount * 12, 0, Math.PI * 2); scoreCtx.fill();
  }
  scoreCtx.globalAlpha = 1;
}

function analyze(now = performance.now()) {
  drawScore(now); drawWaveform(); updateTimeline();
  if (!running || video.paused || video.ended) { requestAnimationFrame(analyze); return; }
  const width = canvas.width, height = canvas.height;
  ctx.drawImage(video, 0, 0, width, height); const frame = ctx.getImageData(0, 0, width, height);
  if (previousFrame) {
    const cols = 4, zoneWidth = width / cols, zoneHeight = height / 3;
    const values = new Array(12).fill(0), counts = new Array(12).fill(0);
    const changedPoints = [];
    const threshold = Number(controls.pixelThreshold.value);
    const sensitivity = Number(controls.zoneSensitivity.value) / 100;
    let total = 0, bestZone = -1, bestRatio = 0;
    for (let y = 0; y < height; y += 3) for (let x = 0; x < width; x += 3) {
      const index = (y * width + x) * 4;
      const current = .3 * frame.data[index] + .59 * frame.data[index + 1] + .11 * frame.data[index + 2];
      const previous = .3 * previousFrame.data[index] + .59 * previousFrame.data[index + 1] + .11 * previousFrame.data[index + 2];
      const zone = Math.min(3, Math.floor(x / zoneWidth)) + Math.min(2, Math.floor(y / zoneHeight)) * 4;
      counts[zone] += 1;
      if (Math.abs(current - previous) > threshold) {
        values[zone] += 1;
        changedPoints.push([x, y, zone]);
      }
    }
    const ratios = values.map((value, zone) => value / counts[zone]);
    ratios.forEach((ratio, zone) => {
      total += ratio;
      if (ratio > bestRatio) { bestRatio = ratio; bestZone = zone; }
    });
    const activeZones = ratios.map((ratio, zone) => ({ ratio, zone })).filter((item) => item.ratio > sensitivity).sort((a, b) => b.ratio - a.ratio).slice(0, 2);
    const activeZoneIds = activeZones.map((item) => item.zone);
    const active = activeZones.length > 0;
    const mask = ctx.createImageData(width, height);
    if (active) changedPoints.forEach(([x, y, zone]) => {
      if (!activeZoneIds.includes(zone)) return;
      for (let offsetY = 0; offsetY < 3 && y + offsetY < height; offsetY += 1) {
        for (let offsetX = 0; offsetX < 3 && x + offsetX < width; offsetX += 1) {
          const pixel = ((y + offsetY) * width + x + offsetX) * 4;
          const zoneColor = getZoneColors()[zone];
          mask.data[pixel] = zoneColor[0]; mask.data[pixel + 1] = zoneColor[1];
          mask.data[pixel + 2] = zoneColor[2]; mask.data[pixel + 3] = 220;
        }
      }
    });
    ctx.clearRect(0, 0, width, height); ctx.putImageData(mask, 0, 0);
    const immersive = document.body.classList.contains('immersive-mode') || document.fullscreenElement === $('.experience');
    ratios.forEach((ratio, zone) => {
      const x = (zone % 4) * zoneWidth, y = Math.floor(zone / 4) * zoneHeight;
      const isActive = activeZoneIds.includes(zone);
      if (!immersive) {
        ctx.lineWidth = isActive ? 3 : 1;
        const zoneColor = getZoneColors()[zone];
        ctx.strokeStyle = isActive
          ? `rgba(${zoneColor[0]},${zoneColor[1]},${zoneColor[2]},1)`
          : `rgba(${zoneColor[0]},${zoneColor[1]},${zoneColor[2]},${.1 + ratio * .45})`;
        ctx.strokeRect(x + 1, y + 1, zoneWidth - 2, zoneHeight - 2);
      }
    });
    total = Math.min(1, total / 2.2); $('#motionReadout').textContent = `${Math.round(total * 100)}%`;
    $('#motionMeter').style.width = `${total * 100}%`;
    $('#zoneReadout').textContent = bestZone < 0 ? '—' : `${Math.floor(bestZone / 4) + 1}.${bestZone % 4 + 1}`;
    if (active) {
      lastActivity = now; $('#statusDot').classList.add('active');
      $('#statusText').textContent = 'Cambio detectado';
      const wait = Math.max(900, Number(controls.cooldown.value));
      const mix = getStageMix();
      activeZones.forEach(({ zone, ratio }, index) => {
        if (now - lastTrigger[zone] <= wait) return;
        const useSecondary = index === 1 && mix.secondary && mix.fade > .15;
        const kind = useSecondary ? mix.secondary : mix.primary;
        const weight = useSecondary ? Math.max(.3, mix.fade) : 1 - mix.fade * .35;
        lastTrigger[zone] = now; globalLastTrigger = now;
        triggerSound(kind, Math.min(1, ratio * 4) * weight, zone);
      });
    } else {
      $('#statusDot').classList.remove('active'); $('#statusText').textContent = 'Escuchando el silencio';
      const quietKind = getStage().kind;
      if (now - lastActivity > 2200 && now - globalLastTrigger > quietIntervals[quietKind]) {
        triggerSound(quietKind, quietKind === 'caja' ? .46 : .32, 5);
      }
    }
  }
  previousFrame = frame; requestAnimationFrame(analyze);
}

function bindRange(input, output, format = (value) => value) {
  input.addEventListener('input', () => { output.value = format(input.value); });
}

loadSegment(0, false); new ResizeObserver(resizeAnalysis).observe(canvas);
const storedSoundChoices = JSON.parse(localStorage.getItem('infancias-enabled-sounds-v2') || 'null');
const allSoundFiles = [...new Set(Object.values(sounds).flat())];
const enabledSoundFiles = new Set(Array.isArray(storedSoundChoices) ? storedSoundChoices : allSoundFiles);
document.querySelectorAll('[data-sound]').forEach((input) => {
  input.checked = enabledSoundFiles.has(input.dataset.sound);
  input.addEventListener('change', () => {
    if (input.checked) enabledSoundFiles.add(input.dataset.sound); else enabledSoundFiles.delete(input.dataset.sound);
    localStorage.setItem('infancias-enabled-sounds-v2', JSON.stringify([...enabledSoundFiles]));
  });
});
document.querySelectorAll('[data-preview]').forEach((button) => button.addEventListener('click', async (event) => {
  event.preventDefault(); event.stopPropagation(); await initAudio(); await audioContext.resume();
  const buffer = audioBuffers.get(button.dataset.preview); if (!buffer) return;
  const source = audioContext.createBufferSource(); const auditionGain = audioContext.createGain(); source.buffer = buffer;
  auditionGain.gain.value = Math.min(1.1, .72 * (fileGainCompensation[button.dataset.preview] || 1));
  source.connect(auditionGain).connect(masterGain); source.start();
}));
const savedMix = JSON.parse(localStorage.getItem('infancias-group-volumes-v3') || '{}');
['gameVolume', 'boxVolume', 'breathVolume', 'voiceVolume'].forEach((name) => {
  if (savedMix[name] !== undefined) controls[name].value = savedMix[name];
  controls[name].addEventListener('input', () => {
    savedMix[name] = Number(controls[name].value);
    localStorage.setItem('infancias-group-volumes-v3', JSON.stringify(savedMix));
  });
});
bindRange(controls.pixelThreshold, $('#pixelThresholdValue'));
bindRange(controls.zoneSensitivity, $('#zoneSensitivityValue'), (value) => `${value}%`);
bindRange(controls.cooldown, $('#cooldownValue'), (value) => `${value} ms`);
bindRange(controls.masterVolume, $('#masterVolumeValue'), (value) => `${value}%`);
bindRange(controls.gameVolume, $('#gameVolumeValue'), (value) => `${value}%`);
bindRange(controls.boxVolume, $('#boxVolumeValue'), (value) => `${value}%`);
bindRange(controls.breathVolume, $('#breathVolumeValue'), (value) => `${value}%`);
bindRange(controls.voiceVolume, $('#voiceVolumeValue'), (value) => `${value}%`);
bindRange(controls.distortionAmount, $('#distortionAmountValue'), (value) => `${value}%`);
$('#gameVolumeValue').value = `${controls.gameVolume.value}%`;
$('#boxVolumeValue').value = `${controls.boxVolume.value}%`;
$('#breathVolumeValue').value = `${controls.breathVolume.value}%`;
$('#voiceVolumeValue').value = `${controls.voiceVolume.value}%`;
controls.masterVolume.addEventListener('input', () => {
  if (masterGain && !muted) masterGain.gain.setTargetAtTime(Number(controls.masterVolume.value) / 100, audioContext.currentTime, .04);
});
video.loop = false;
controls.spectrumMapping.addEventListener('change', () => {
  $('.viewer').classList.toggle('spectrum-on', controls.spectrumMapping.checked);
});
$('.viewer').classList.toggle('spectrum-on', controls.spectrumMapping.checked);
$('#stageSelect').addEventListener('change', (event) => {
  loadSegment(Number(event.target.value), running); lastActivity = performance.now();
});
function updatePlaybackButtons() {
  $('#startButton').textContent = running ? 'Pausar escucha' : (video.currentTime > 0 ? 'Continuar escucha' : 'Comenzar escucha');
  $('#immersivePlaybackButton').textContent = running ? 'Pausar' : (video.currentTime > 0 ? 'Continuar' : 'Comenzar');
}

async function togglePlayback() {
  await initAudio(); await audioContext.resume();
  if (video.paused) {
    await video.play(); running = true; $('#muteButton').disabled = false;
    if (!animationStarted) { animationStarted = true; requestAnimationFrame(analyze); }
    setTimeout(() => triggerSound(getStage().kind, getStage().kind === 'caja' ? .68 : .42, 5), 180);
  } else {
    video.pause(); running = false;
    $('#statusText').textContent = 'Pausa'; $('#statusDot').classList.remove('active');
  }
  updatePlaybackButtons();
}

$('#startButton').addEventListener('click', togglePlayback);
$('#immersivePlaybackButton').addEventListener('click', togglePlayback);

function updateImmersiveButton() {
  const active = document.fullscreenElement === $('.experience') || document.body.classList.contains('immersive-mode');
  $('#fullscreenButton').textContent = active ? 'Salir de pantalla completa' : 'Pantalla completa';
}

async function toggleImmersiveMode() {
  const experience = $('.experience');
  const active = document.fullscreenElement === experience || document.body.classList.contains('immersive-mode');
  if (active) {
    if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
    document.body.classList.remove('immersive-mode');
  } else {
    document.body.classList.add('immersive-mode');
    if (experience.requestFullscreen) {
      try { await experience.requestFullscreen(); } catch (error) { console.info('Se utiliza el modo inmersivo compatible.', error); }
    }
  }
  updateImmersiveButton(); resizeAnalysis();
}

$('#fullscreenButton').addEventListener('click', toggleImmersiveMode);
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) document.body.classList.remove('immersive-mode');
  updateImmersiveButton(); resizeAnalysis();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('immersive-mode') && !document.fullscreenElement) {
    document.body.classList.remove('immersive-mode'); updateImmersiveButton(); resizeAnalysis();
  }
});
$('#muteButton').addEventListener('click', () => {
  muted = !muted; masterGain.gain.setTargetAtTime(muted ? 0 : Number(controls.masterVolume.value) / 100, audioContext.currentTime, .04);
  $('#muteButton').textContent = muted ? 'Activar sonido' : 'Silenciar';
});
video.addEventListener('timeupdate', () => {
  if (!segmentReady || video.currentTime < segments[currentSegment].end) return;
  if (currentSegment === segments.length - 1 && !controls.loopVideo.checked) {
    video.pause(); running = false; $('#statusText').textContent = 'Fin del montaje'; updatePlaybackButtons();
  } else loadSegment(currentSegment + 1, running);
});
video.addEventListener('ended', () => {
  if (currentSegment === segments.length - 1 && !controls.loopVideo.checked) return;
  loadSegment(currentSegment + 1, running);
});
$('#aboutButton').addEventListener('click', () => $('#aboutDialog').showModal());
$('#closeDialog').addEventListener('click', () => $('#aboutDialog').close());
