// app.js
// Lógica principal: conecta la UI, los sensores BLE, el FTP y Google Sheets.

import * as ble from './bluetooth.js';
import * as sheets from './sheets.js';
import * as workouts from './workouts.js';
import * as history from './history.js';
import * as ftp from './ftp.js';
import { initWorkoutEditor } from './workout-editor.js';
import { initChart, pushSample, resetChart } from './livechart.js';

const SPREADSHEET_ID = 'TU_SPREADSHEET_ID'; // reemplaza con el ID de tu hoja de cálculo

let workout = null;
let currentFTP = null;
let currentIntervalIndex = 0;
let intervalElapsed = 0;
let sessionElapsed = 0;
let timer = null;
let session = { powerSamples: [], hrSamples: [], cadenceSamples: [] };

const el = {
  power: document.getElementById('power'),
  cadence: document.getElementById('cadence'),
  hr: document.getElementById('hr'),
  target: document.getElementById('target'),
  hydration: document.getElementById('hydration'),
  workoutName: document.getElementById('workout-name'),
  timeline: document.getElementById('timeline'),
  status: document.getElementById('status'),
  ftpValue: document.getElementById('ftp-value'),
  ftpInput: document.getElementById('ftp-input'),
};

document.getElementById('connect-power').onclick = () => ble.connectPowerMeter().catch(showError);
document.getElementById('connect-trainer').onclick = () =>
  ble.connectTrainer(() => applyCurrentInterval().catch(showError)).catch(showError);
document.getElementById('connect-hr').onclick = () => ble.connectHeartRateMonitor().catch(showError);
document.getElementById('load-workout').onclick = () => loadTodayWorkout().catch(showError);
document.getElementById('start').onclick = () => startSession().catch(showError);
document.getElementById('stop').onclick = () => stopSession().catch(showError);
document.getElementById('save-ftp').onclick = () => saveManualFTP().catch(showError);
document.getElementById('check-ftp').onclick = () => checkFTPSuggestion().catch(showError);

ble.onData((state) => {
  el.power.textContent = state.power ?? state.trainerPower ?? '--';
  el.cadence.textContent = state.cadence ?? state.trainerCadence ?? '--';
  el.hr.textContent = state.heartRate ?? '--';
});

// Reutiliza el status de conexión/reconexión del módulo BLE (desconexiones, reintentos, etc.)
ble.onStatus((message) => {
  el.status.textContent = message;
});

initChart('live-chart');
initWorkoutEditor(SPREADSHEET_ID);

async function ensureSignedIn() {
  sheets.initGoogleClient();
  await sheets.signIn();
}

async function loadTodayWorkout() {
  el.status.textContent = 'Conectando con Google Sheets...';
  await ensureSignedIn();

  const ftpRecord = await ftp.getCurrentFTP(SPREADSHEET_ID);
  currentFTP = ftpRecord?.ftp ?? null;
  el.ftpValue.textContent = currentFTP ?? '--';

  const today = new Date().toISOString().slice(0, 10);
  const raw = await workouts.getWorkoutForDate(SPREADSHEET_ID, today);
  if (!raw) {
    el.status.textContent = 'Sin entrenamiento asignado para hoy.';
    return;
  }
  workout = { name: raw.name, intervals: ftp.resolveIntervalsToWatts(raw.intervals, currentFTP) };
  el.workoutName.textContent = workout.name;
  el.hydration.textContent = raw.hydration || 'Sin datos';
  renderTimeline(workout.intervals);
  el.status.textContent = 'Entrenamiento cargado. Listo para empezar.';
}

function renderTimeline(intervals) {
  el.timeline.innerHTML = '';
  const totalDuration = intervals.reduce((sum, i) => sum + i.duration, 0);
  const maxPower = Math.max(...intervals.map((i) => i.targetPower), 1);
  intervals.forEach((interval) => {
    const segment = document.createElement('div');
    segment.className = 'segment';
    segment.style.flexGrow = String(interval.duration / totalDuration);
    segment.style.setProperty('--h', `${Math.min(100, (interval.targetPower / maxPower) * 100)}%`);
    el.timeline.appendChild(segment);
  });
}

async function startSession() {
  if (!workout) {
    showError(new Error('Primero carga el entrenamiento del día'));
    return;
  }
  currentIntervalIndex = 0;
  intervalElapsed = 0;
  sessionElapsed = 0;
  session = { powerSamples: [], hrSamples: [], cadenceSamples: [] };
  resetChart();
  await ble.startWorkout();
  await applyCurrentInterval();
  timer = setInterval(tick, 1000);
  el.status.textContent = 'Entrenamiento en curso.';
}

async function applyCurrentInterval() {
  const interval = workout.intervals[currentIntervalIndex];
  if (!interval) {
    await finishSession();
    return;
  }
  el.target.textContent = interval.targetPower;
  await ble.setTargetPower(interval.targetPower);
}

function tick() {
  sessionElapsed += 1;
  intervalElapsed += 1;

  const power = ble.state.power ?? ble.state.trainerPower ?? 0;
  const hr = ble.state.heartRate ?? 0;
  const cadence = ble.state.cadence ?? ble.state.trainerCadence ?? 0;

  session.powerSamples.push(power);
  session.hrSamples.push(hr);
  session.cadenceSamples.push(cadence);
  pushSample(sessionElapsed, power, hr);

  const interval = workout.intervals[currentIntervalIndex];
  if (interval && intervalElapsed >= interval.duration) {
    currentIntervalIndex += 1;
    intervalElapsed = 0;
    applyCurrentInterval().catch(showError);
  }
}

async function stopSession() {
  clearInterval(timer);
  await ble.stopWorkout();
  await finishSession();
}

async function finishSession() {
  clearInterval(timer);
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
  const summary = {
    date: new Date().toISOString().slice(0, 10),
    workoutName: workout?.name ?? 'Sesión libre',
    durationSec: sessionElapsed,
    avgPower: avg(session.powerSamples),
    normalizedPower: computeNormalizedPower(session.powerSamples),
    avgHeartRate: avg(session.hrSamples),
    avgCadence: avg(session.cadenceSamples),
  };
  await history.appendSessionSummary(SPREADSHEET_ID, summary);
  el.status.textContent = 'Sesión guardada en Google Sheets.';
}

// Potencia normalizada (método de Coggan, el estándar que usan TrainerRoad/TrainingPeaks):
// media móvil de 30s, elevada a la 4ta potencia, promediada, y raíz 4ta del resultado.
function computeNormalizedPower(samples) {
  if (samples.length < 30) return avgSimple(samples);
  const rolling = [];
  for (let i = 29; i < samples.length; i++) {
    const window = samples.slice(i - 29, i + 1);
    rolling.push(window.reduce((a, b) => a + b, 0) / 30);
  }
  const meanFourth = rolling.reduce((sum, v) => sum + v ** 4, 0) / rolling.length;
  return Math.round(meanFourth ** 0.25);
}

function avgSimple(samples) {
  return samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : 0;
}

// --- FTP ---

async function saveManualFTP() {
  const value = Number(el.ftpInput.value);
  if (!value) throw new Error('Ingresa un valor de FTP válido');
  await ensureSignedIn();
  const record = await ftp.recordFTP(SPREADSHEET_ID, value, 'manual');
  currentFTP = record.ftp;
  el.ftpValue.textContent = currentFTP;
  el.status.textContent = `FTP actualizado a ${currentFTP} W.`;
}

async function checkFTPSuggestion() {
  await ensureSignedIn();
  if (!currentFTP) {
    const record = await ftp.getCurrentFTP(SPREADSHEET_ID);
    currentFTP = record?.ftp ?? null;
  }
  if (!currentFTP) {
    el.status.textContent = 'Registra un FTP inicial antes de pedir una sugerencia.';
    return;
  }
  const result = await ftp.suggestFTPAdjustment(SPREADSHEET_ID, currentFTP);
  if (result.suggestion === 'datos-insuficientes') {
    el.status.textContent = 'Aún no hay suficientes sesiones en el historial para sugerir un cambio.';
  } else if (result.suggestion === 'mantener') {
    el.status.textContent = `Tu FTP de ${currentFTP} W sigue reflejando bien tu esfuerzo reciente.`;
  } else {
    el.status.textContent = `Sugerencia: ${result.suggestion} el FTP a ${result.newFTP} W, según tus últimas sesiones.`;
  }
}

function showError(err) {
  console.error(err);
  el.status.textContent = `Error: ${err.message}`;
}
