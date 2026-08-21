// app.js
// Lógica principal: conecta la UI, los sensores BLE, el FTP y Google Sheets.

import * as ble from './bluetooth.js';
import * as sheets from './sheets.js';
import * as strava from './strava.js';
import * as workouts from './workouts.js';
import * as history from './history.js';
import * as ftp from './ftp.js';
import { initChart, pushSample, resetChart, resizeChart, setFTP as setLiveChartFTP } from './livechart.js';
import {
  createIntervalChart,
  renderProfile,
  renderZoom,
  renderActualTrace,
  setPlayhead,
} from './profilechart.js';

const SPREADSHEET_ID = '120Aj__g0WVQhXWITy1O4C-kltYQKw9-N-OJIgshDlB0';
const ZERO_POWER_STREAK_TO_AUTOPAUSE = 2; // segundos consecutivos en 0 W antes de auto-pausar
const ERG_REFRESH_SECONDS = 2; // cada cuántos segundos se reafirma el target ERG al rodillo

let workout = null;
let currentFTP = null;
let currentIntervalIndex = 0;
let intervalElapsed = 0;
let sessionElapsed = 0;
let sessionStartedAt = null; // Date real de inicio, para armar los timestamps del TCX de Strava
let timer = null;
let session = { powerSamples: [], hrSamples: [], cadenceSamples: [] };

let sessionState = 'idle'; // 'idle' | 'running' | 'paused' | 'finished'
let pauseReason = null; // 'manual' | 'auto' | null
let zeroPowerStreak = 0;
let intensityScale = 1;
// 'trainer' | 'powerMeter' | null. null = automático (prioriza el potenciómetro si hay
// varios sensores de potencia conectados). Se resetea si el sensor elegido se desconecta.
let powerSourcePreference = null;

let profileChart = null;
let zoomChart = null;
let availableWorkouts = [];
let hydrationReminders = []; // segundos de sesión en los que conviene tomar agua

const el = {
  power: document.getElementById('power'),
  cadence: document.getElementById('cadence'),
  hr: document.getElementById('hr'),
  target: document.getElementById('target'),
  hydration: document.getElementById('hydration'),
  workoutTitle: document.getElementById('workout-title'),
  headerAlert: document.getElementById('header-alert'),
  status: document.getElementById('status'),
  start: document.getElementById('start'),
  intervalTime: document.getElementById('interval-time'),
  totalTime: document.getElementById('total-time'),
  endTime: document.getElementById('end-time'),
  pauseToggle: document.getElementById('pause-toggle'),
  menuToggle: document.getElementById('menu-toggle'),
  sessionMenu: document.getElementById('session-menu'),
  menuStrava: document.getElementById('menu-strava'),
  menuCalibrate: document.getElementById('menu-calibrate'),
  menuDiscard: document.getElementById('menu-discard'),
  menuSave: document.getElementById('menu-save'),
  intensitySelect: document.getElementById('intensity-select'),
  devicesToggle: document.getElementById('devices-toggle'),
  devicesPopover: document.getElementById('devices-popover'),
  pairedCount: document.getElementById('paired-count'),
  workoutSelect: document.getElementById('workout-select'),
  loadWorkout: document.getElementById('load-workout'),
  liveSessionToggle: document.getElementById('live-session-toggle'),
  liveSessionBody: document.getElementById('live-session-body'),
  liveSessionChevron: document.getElementById('live-session-chevron'),
  connectTrainerBtn: document.getElementById('connect-trainer'),
  connectPowerBtn: document.getElementById('connect-power'),
  connectHrBtn: document.getElementById('connect-hr'),
  trainerBattery: document.getElementById('trainer-battery'),
  powerMeterBattery: document.getElementById('power-meter-battery'),
  hrBattery: document.getElementById('hr-battery'),
  powerSourceTrainerLabel: document.getElementById('power-source-trainer-label'),
  powerSourcePowerMeterLabel: document.getElementById('power-source-power-meter-label'),
  powerSourceTrainerRadio: document.getElementById('power-source-trainer'),
  powerSourcePowerMeterRadio: document.getElementById('power-source-power-meter'),
  toast: document.getElementById('toast'),
  countdownOverlay: document.getElementById('countdown-overlay'),
  countdownNumber: document.getElementById('countdown-number'),
  deviceGate: document.getElementById('device-gate'),
  gateConnectTrainer: document.getElementById('gate-connect-trainer'),
  gateConnectPower: document.getElementById('gate-connect-power'),
  gateConnectHr: document.getElementById('gate-connect-hr'),
  gateCancel: document.getElementById('gate-cancel'),
  gateBegin: document.getElementById('gate-begin'),
  finishModal: document.getElementById('finish-modal'),
  finishYes: document.getElementById('finish-yes'),
  finishNo: document.getElementById('finish-no'),
  calibrationModal: document.getElementById('calibration-modal'),
  calibrationStatus: document.getElementById('calibration-status'),
  calibrationTimer: document.getElementById('calibration-timer'),
  calibrationStart: document.getElementById('calibration-start'),
  calibrationCancel: document.getElementById('calibration-cancel'),
  calibrationRetry: document.getElementById('calibration-retry'),
  calibrationClose: document.getElementById('calibration-close'),
  speedoFill: document.getElementById('speedo-fill'),
  speedoValue: document.getElementById('speedo-value'),
  calibrationUnsupported: document.getElementById('calibration-unsupported'),
  calibrationUnsupportedClose: document.getElementById('calibration-unsupported-close'),
};

function connectTrainerDevice() {
  return ble.connectTrainer(() => applyCurrentInterval().catch(showError)).catch(showError);
}
function connectPowerMeterDevice() {
  return ble.connectPowerMeter().catch(showError);
}
function connectHeartRateDevice() {
  return ble.connectHeartRateMonitor().catch(showError);
}

el.connectPowerBtn.onclick = connectPowerMeterDevice;
el.connectTrainerBtn.onclick = connectTrainerDevice;
el.connectHrBtn.onclick = connectHeartRateDevice;
el.gateConnectTrainer.onclick = connectTrainerDevice;
el.gateConnectPower.onclick = connectPowerMeterDevice;
el.gateConnectHr.onclick = connectHeartRateDevice;

el.loadWorkout.onclick = () => loadWorkoutList().catch(showError);
el.workoutSelect.onchange = () => selectWorkoutFromList();
el.start.onclick = () => beginCountdown().catch(showError);

el.powerSourceTrainerRadio.onchange = () => {
  powerSourcePreference = 'trainer';
};
el.powerSourcePowerMeterRadio.onchange = () => {
  powerSourcePreference = 'powerMeter';
};

el.liveSessionToggle.onclick = () => {
  const nowHidden = el.liveSessionBody.classList.toggle('hidden');
  el.liveSessionChevron.classList.toggle('open', !nowHidden);
  if (!nowHidden) resizeChart();
};

el.pauseToggle.onclick = () => {
  if (sessionState === 'running') pauseSession('manual');
  else if (sessionState === 'paused') resumeSession('manual').catch(showError);
};

el.menuToggle.onclick = (e) => {
  e.stopPropagation();
  el.devicesPopover.classList.add('hidden');
  el.sessionMenu.classList.toggle('hidden');
};
el.devicesToggle.onclick = (e) => {
  e.stopPropagation();
  el.sessionMenu.classList.add('hidden');
  el.devicesPopover.classList.toggle('hidden');
};
document.addEventListener('click', () => {
  el.sessionMenu.classList.add('hidden');
  el.devicesPopover.classList.add('hidden');
});

el.menuStrava.onclick = () => {
  el.sessionMenu.classList.add('hidden');
  if (strava.isConnected()) {
    if (confirm('¿Desconectar tu cuenta de Strava de esta app?')) {
      strava.disconnect();
      refreshStravaMenuItem();
      showToast('Strava desconectado.');
    }
  } else {
    strava.beginAuthorization(); // navega a strava.com; la app recarga al volver
  }
};
el.menuCalibrate.onclick = () => {
  el.sessionMenu.classList.add('hidden');
  openCalibration();
};
el.menuDiscard.onclick = () => {
  el.sessionMenu.classList.add('hidden');
  discardAndClose().catch(showError);
};
el.menuSave.onclick = () => {
  el.sessionMenu.classList.add('hidden');
  saveAndClose().catch(showError);
};

el.intensitySelect.onchange = () => {
  intensityScale = Number(el.intensitySelect.value) / 100;
  refreshCharts();
  if (sessionState === 'running' || sessionState === 'paused') {
    applyCurrentInterval().catch(showError);
  }
};

// El número grande de Potencia (W) se muestra como promedio de 3s, no el dato crudo de
// cada paquete BLE -- así no salta con cada pedaleo. El resto (auto-pausa, gráficas,
// historial) sigue usando la lectura instantánea de ble.state, sin cambios.
let displayPowerBuffer = [];

// Resuelve qué sensor conectado alimenta el dato de potencia mostrado/grabado. Si el
// usuario eligió uno explícitamente en Devices, se respeta esa elección; si no, por
// defecto se prioriza el potenciómetro sobre el Simulador (comportamiento previo).
function getSelectedPower(state) {
  if (powerSourcePreference === 'trainer') return state.trainerPower;
  if (powerSourcePreference === 'powerMeter') return state.power;
  return state.power ?? state.trainerPower;
}

ble.onData((state) => {
  const power = getSelectedPower(state);
  if (power != null) displayPowerBuffer.push(power);
  el.cadence.textContent = state.cadence ?? state.trainerCadence ?? '--';
  el.hr.textContent = state.heartRate ?? '--';

  if (sessionState === 'paused' && pauseReason === 'auto') {
    const currentPower = getSelectedPower(state) ?? 0;
    if (currentPower > 0) resumeSession('auto').catch(showError);
  }

  if (!el.calibrationModal.classList.contains('hidden')) {
    updateSpeedometer(state.trainerSpeed ?? 0);
  }

  refreshDeviceBatteries();
});

setInterval(() => {
  if (displayPowerBuffer.length) {
    const avg = Math.round(displayPowerBuffer.reduce((a, b) => a + b, 0) / displayPowerBuffer.length);
    el.power.textContent = avg;
    displayPowerBuffer = [];
  }
}, 3000);

// Reutiliza el status de conexión/reconexión del módulo BLE (desconexiones, reintentos, etc.)
// Se muestra como alerta bajo el nombre del entrenamiento, no en el status de sesión.
ble.onStatus((message) => {
  showAlert(message);
});

// El conteo de "Paired" refleja el estado real de conexión GATT, no solo si alguna vez
// se emparejó -- así baja solo cuando un sensor se desconecta de verdad.
ble.onConnectionChange(updatePairedCount);
ble.onConnectionChange(refreshDeviceGate);
ble.onConnectionChange(refreshDevicesPopover);
ble.onSpinDownStatus(handleSpinDownStatus);

el.gateCancel.onclick = () => closeDeviceGate(false);
el.gateBegin.onclick = () => closeDeviceGate(true);
el.finishYes.onclick = () => resolveFinishModal(true);
el.finishNo.onclick = () => resolveFinishModal(false);

el.calibrationStart.onclick = () => startCalibration();
el.calibrationCancel.onclick = () => cancelCalibration();
el.calibrationRetry.onclick = () => setCalibrationState('idle');
el.calibrationClose.onclick = () => closeCalibration();
el.calibrationUnsupportedClose.onclick = () => el.calibrationUnsupported.classList.add('hidden');

initChart('live-chart');
profileChart = createIntervalChart('profile-chart');
zoomChart = createIntervalChart('zoom-chart');
updatePairedCount();
refreshDevicesPopover();

function refreshStravaMenuItem() {
  if (strava.isConnected()) {
    const athlete = strava.getAthleteName();
    el.menuStrava.textContent = athlete ? `✓ Strava: ${athlete} (desconectar)` : '✓ Strava conectado (desconectar)';
  } else {
    el.menuStrava.textContent = 'Conectar Strava';
  }
}

// Si volvemos del redirect de autorización de Strava (?code=...), completa la conexión;
// si no, no hace nada -- es el caso normal de cualquier otra carga de página.
strava.handleAuthorizationRedirect()
  .then((connected) => {
    if (connected) showToast('Cuenta de Strava conectada.');
    refreshStravaMenuItem();
  })
  .catch((err) => {
    showError(err);
    refreshStravaMenuItem();
  });

let toastTimer = null;
// persistent: si es true, el toast no se auto-oculta -- hay que llamar hideToast() a mano
// (se usa para el aviso de pausa, que debe seguir visible mientras dure la pausa).
function showToast(message, kind = 'info', persistent = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('toast-pause', kind === 'pause');
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  if (!persistent) {
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 6000);
  }
}
function hideToast() {
  clearTimeout(toastTimer);
  el.toast.classList.add('hidden');
}

// Mensajes de alerta (fallos de conexión BLE, errores) bajo el nombre del entrenamiento.
function showAlert(message) {
  el.headerAlert.textContent = message;
  el.headerAlert.classList.remove('hidden');
}
function clearAlert() {
  el.headerAlert.classList.add('hidden');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureSignedIn() {
  sheets.initGoogleClient();
  // Sin este chequeo, cada clic en "Cargar entrenamiento" volvía a llamar
  // requestAccessToken() aunque ya hubiera una sesión vigente, lo que hacía que GIS
  // abriera y cerrara una ventana/iframe de más cada vez.
  if (sheets.isSignedIn()) return;
  await sheets.signIn();
}

async function loadWorkoutList() {
  clearAlert();
  el.status.textContent = 'Conectando con Google Sheets...';
  await ensureSignedIn();

  // Ya con la sesión de Google iniciada, este botón no tiene más nada que hacer -- se
  // desactiva y el amarillo (la acción a seguir) pasa al desplegable de entrenamientos.
  el.loadWorkout.disabled = true;
  el.loadWorkout.textContent = '✓ Sheets conectado';
  el.loadWorkout.classList.remove('primary');

  const ftpRecord = await ftp.getCurrentFTP(SPREADSHEET_ID);
  currentFTP = ftpRecord?.ftp ?? null;
  setLiveChartFTP(currentFTP);

  availableWorkouts = await workouts.getAllWorkouts(SPREADSHEET_ID);
  if (!availableWorkouts.length) {
    el.workoutSelect.classList.add('hidden');
    el.status.textContent = 'No hay entrenamientos guardados en el calendario.';
    return;
  }

  el.workoutSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = `Elige un entrenamiento (${availableWorkouts.length})`;
  el.workoutSelect.appendChild(placeholder);
  availableWorkouts.forEach((w, i) => {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = `${w.date} — ${w.name}`;
    el.workoutSelect.appendChild(option);
  });
  el.workoutSelect.value = '';
  el.workoutSelect.classList.remove('hidden');
  el.workoutSelect.classList.add('primary');
  el.status.textContent = 'Elige un entrenamiento del listado.';
}

// Extrae los ml de agua del texto ya calculado en la hoja (ej. "825 ml agua + 1 sobre
// de hidratante") en vez de recalcularlos, para no duplicar la fórmula de hydration.js
// y mantener las líneas de las gráficas siempre consistentes con lo que muestra la app.
function parseHydrationMl(hydrationText) {
  const match = /(\d+)\s*ml/.exec(hydrationText || '');
  return match ? Number(match[1]) : 0;
}

// Reparte recordatorios de "tomar agua": más volumen sugerido, más recordatorios (uno
// cada ~100 ml, un trago típico). A diferencia de repartirlos por partes iguales en el
// tiempo total (podían caer en medio de un esfuerzo fuerte), los ubica dentro de los
// tramos del entrenamiento donde de verdad conviene tomar agua -- todo lo que no sea
// umbral o más arriba (zonas de Coggan: recuperación/endurance/tempo, hasta ~88% FTP).
// Por encima de eso (umbral, VO2max, anaeróbico) no se recomienda tomar.
const ML_PER_HYDRATION_REMINDER = 100;
const HYDRATABLE_INTENSITY_RATIO = 0.88; // %FTP (o del pico del entrenamiento) por debajo del cual sí conviene recomendar tomar agua
const MIN_RECOVERY_DURATION_SEC = 20; // tramos más cortos no dan tiempo real a tomar agua

function computeHydrationReminders(waterMl, intervals, ftpValue) {
  const totalDurationSec = intervals.reduce((sum, i) => sum + i.duration, 0);
  if (!waterMl || !totalDurationSec) return [];
  const count = Math.max(1, Math.round(waterMl / ML_PER_HYDRATION_REMINDER));

  let cursor = 0;
  const placed = intervals.map((interval) => {
    const start = cursor;
    cursor += interval.duration;
    return { start, duration: interval.duration, targetPower: interval.targetPower };
  });

  const maxTarget = Math.max(0, ...placed.map((i) => i.targetPower));
  const threshold = (ftpValue || maxTarget) * HYDRATABLE_INTENSITY_RATIO;
  let recovery = placed.filter((i) => i.targetPower <= threshold && i.duration >= MIN_RECOVERY_DURATION_SEC);

  // Si todos los tramos son muy exigentes (ej. un test a bloque único por encima del
  // umbral), usa los de menor intensidad relativa del propio entrenamiento como mejor
  // alternativa disponible -- mejor recomendar en el momento "menos malo" que no
  // recomendar tomar agua en toda la sesión.
  if (!recovery.length) {
    recovery = [...placed].sort((a, b) => a.targetPower - b.targetPower).slice(0, Math.max(1, Math.ceil(placed.length / 2)));
    recovery.sort((a, b) => a.start - b.start);
  }

  // Reparte los recordatorios entre esos tramos proporcional a su duración -- uno más
  // largo recibe más de un recordatorio -- y los ubica en partes iguales dentro de cada uno.
  const totalRecoveryDuration = recovery.reduce((sum, i) => sum + i.duration, 0);
  const times = [];
  let remaining = count;
  recovery.forEach((interval, idx) => {
    const isLast = idx === recovery.length - 1;
    const share = isLast ? remaining : Math.max(1, Math.round((interval.duration / totalRecoveryDuration) * count));
    const n = Math.min(remaining, share);
    for (let k = 1; k <= n; k++) {
      times.push(Math.round(interval.start + (interval.duration * k) / (n + 1)));
    }
    remaining -= n;
  });

  return times.sort((a, b) => a - b);
}

function selectWorkoutFromList() {
  if (el.workoutSelect.value === '') return;
  const raw = availableWorkouts[Number(el.workoutSelect.value)];
  workout = { name: raw.name, intervals: ftp.resolveIntervalsToWatts(raw.intervals, currentFTP) };
  el.workoutTitle.textContent = workout.name;
  el.hydration.textContent = raw.hydration || 'Sin datos';
  hydrationReminders = computeHydrationReminders(parseHydrationMl(raw.hydration), workout.intervals, currentFTP);
  refreshCharts();
  el.workoutSelect.classList.remove('primary');
  el.start.classList.add('primary');
  el.status.textContent = 'Entrenamiento cargado. Listo para empezar.';
}

// Vatiaje objetivo real de un intervalo, después de aplicar el % de Intensity elegido.
function scaleTarget(interval) {
  return Math.round(interval.targetPower * intensityScale);
}

function getScaledIntervals() {
  return workout.intervals.map((interval) => ({ ...interval, targetPower: scaleTarget(interval) }));
}

function refreshCharts() {
  if (!workout) return;
  const scaled = getScaledIntervals();
  renderProfile(profileChart, scaled, currentFTP, hydrationReminders);
  renderZoom(zoomChart, scaled, currentFTP, sessionElapsed, hydrationReminders);
  renderActualTrace(profileChart, session.powerSamples, session.hrSamples);
  renderActualTrace(zoomChart, session.powerSamples, session.hrSamples);
  setPlayhead(profileChart, sessionElapsed);
  setPlayhead(zoomChart, sessionElapsed);
}

function refreshConnectButton(button, connected) {
  button.textContent = connected ? '✓ Conectado' : 'Conectar';
  button.disabled = connected;
  button.classList.toggle('connected', connected);
}

// Al menos un sensor de potencia (Simulador o potenciómetro/biela/pedales) es lo mínimo
// indispensable para empezar; el resto es opcional.
function hasPowerSource() {
  return ble.state.connected.trainer || ble.state.connected.powerMeter;
}

function refreshDeviceGate() {
  refreshConnectButton(el.gateConnectTrainer, ble.state.connected.trainer);
  refreshConnectButton(el.gateConnectPower, ble.state.connected.powerMeter);
  refreshConnectButton(el.gateConnectHr, ble.state.connected.heartRate);
  el.gateBegin.disabled = !hasPowerSource();
}

function updateDeviceBattery(badgeEl, key) {
  const value = ble.state.battery[key];
  if (value == null) {
    badgeEl.classList.add('hidden');
  } else {
    badgeEl.textContent = `🔋 ${value}%`;
    badgeEl.classList.remove('hidden');
  }
}
function refreshDeviceBatteries() {
  updateDeviceBattery(el.trainerBattery, 'trainer');
  updateDeviceBattery(el.powerMeterBattery, 'powerMeter');
  updateDeviceBattery(el.hrBattery, 'heartRate');
}

// Muestra el selector de "fuente de potencia" solo junto a sensores realmente conectados,
// y si el sensor elegido se desconecta, vuelve al modo automático.
function refreshPowerSourceUI() {
  const trainerConnected = ble.state.connected.trainer;
  const powerMeterConnected = ble.state.connected.powerMeter;

  el.powerSourceTrainerLabel.classList.toggle('hidden', !trainerConnected);
  el.powerSourcePowerMeterLabel.classList.toggle('hidden', !powerMeterConnected);

  if (powerSourcePreference === 'trainer' && !trainerConnected) powerSourcePreference = null;
  if (powerSourcePreference === 'powerMeter' && !powerMeterConnected) powerSourcePreference = null;

  el.powerSourceTrainerRadio.checked = powerSourcePreference === 'trainer';
  el.powerSourcePowerMeterRadio.checked = powerSourcePreference === 'powerMeter';
}

function refreshDevicesPopover() {
  refreshConnectButton(el.connectTrainerBtn, ble.state.connected.trainer);
  refreshConnectButton(el.connectPowerBtn, ble.state.connected.powerMeter);
  refreshConnectButton(el.connectHrBtn, ble.state.connected.heartRate);
  refreshPowerSourceUI();
  refreshDeviceBatteries();
}

let gateResolve = null;

function ensureDevicesReady() {
  if (hasPowerSource()) return Promise.resolve(true);
  return new Promise((resolve) => {
    gateResolve = resolve;
    refreshDeviceGate();
    el.deviceGate.classList.remove('hidden');
  });
}

function closeDeviceGate(result) {
  el.deviceGate.classList.add('hidden');
  if (gateResolve) {
    gateResolve(result);
    gateResolve = null;
  }
}

let finishResolve = null;
function askSaveToHistory() {
  return new Promise((resolve) => {
    finishResolve = resolve;
    el.finishModal.classList.remove('hidden');
  });
}
function resolveFinishModal(result) {
  el.finishModal.classList.add('hidden');
  if (finishResolve) {
    finishResolve(result);
    finishResolve = null;
  }
}

// --- Calibración del Simulador (spin down FTMS) ---

const SPEEDO_MAX_KMH = 50;
const SPEEDO_ARC_LENGTH = 376.99; // debe coincidir con el dasharray del SVG en index.html

function updateSpeedometer(speedKmh) {
  const clamped = Math.max(0, Math.min(SPEEDO_MAX_KMH, speedKmh || 0));
  const offset = SPEEDO_ARC_LENGTH * (1 - clamped / SPEEDO_MAX_KMH);
  el.speedoFill.style.strokeDashoffset = String(offset);
  el.speedoValue.textContent = Math.round(clamped);
}

let calibrationState = 'idle'; // 'idle' | 'spinning-up' | 'coasting' | 'success' | 'error'
let calibrationTimerInterval = null;
let calibrationStartedAt = 0;

function openCalibration() {
  if (!ble.state.connected.trainer) {
    showAlert('Conecta el Simulador primero para calibrarlo.');
    return;
  }
  if (!ble.state.trainerSpinDownSupported) {
    el.calibrationUnsupported.classList.remove('hidden');
    return;
  }
  updateSpeedometer(0);
  setCalibrationState('idle');
  el.calibrationModal.classList.remove('hidden');
}

function setCalibrationState(next, extra) {
  calibrationState = next;
  clearInterval(calibrationTimerInterval);
  el.calibrationTimer.classList.add('hidden');

  const messages = {
    idle: 'Pedalea hasta alcanzar 40 km/h.',
    'spinning-up': 'Sube la velocidad hasta 40 km/h...',
    coasting: '¡Listo! Deja de pedalear y espera a que la rueda se detenga sola.',
    success: '¡Calibración exitosa!',
    error: extra || 'La calibración falló. Puedes intentarlo de nuevo.',
  };
  el.calibrationStatus.textContent = messages[next];

  el.calibrationStart.classList.toggle('hidden', next !== 'idle');
  el.calibrationCancel.classList.toggle('hidden', next === 'success' || next === 'error');
  el.calibrationRetry.classList.toggle('hidden', next !== 'error');
  el.calibrationClose.classList.toggle('hidden', next !== 'success' && next !== 'error');

  if (next === 'coasting') {
    calibrationStartedAt = Date.now();
    el.calibrationTimer.classList.remove('hidden');
    el.calibrationTimer.textContent = '0:00';
    calibrationTimerInterval = setInterval(() => {
      el.calibrationTimer.textContent = formatMMSS((Date.now() - calibrationStartedAt) / 1000);
    }, 200);
  }
}

async function startCalibration() {
  setCalibrationState('spinning-up');
  try {
    await ble.startSpinDown();
  } catch (err) {
    setCalibrationState('error', err.message);
  }
}

async function cancelCalibration() {
  clearInterval(calibrationTimerInterval);
  if (calibrationState !== 'idle') {
    await ble.cancelSpinDown().catch(() => {});
  }
  el.calibrationModal.classList.add('hidden');
}

function closeCalibration() {
  clearInterval(calibrationTimerInterval);
  el.calibrationModal.classList.add('hidden');
}

// Reacciona a las notificaciones de Fitness Machine Status solo mientras el modal de
// calibración está abierto -- fuera de eso, ignorarlas (no deberían llegar, pero por
// las dudas no queremos que un evento suelto abra o cambie nada).
function handleSpinDownStatus(subStatus) {
  if (el.calibrationModal.classList.contains('hidden')) return;
  if (subStatus === 'requested') setCalibrationState('spinning-up');
  else if (subStatus === 'stop-pedaling') setCalibrationState('coasting');
  else if (subStatus === 'success') setCalibrationState('success');
  else if (subStatus === 'error') setCalibrationState('error');
}

async function beginCountdown() {
  if (!workout) {
    showError(new Error('Primero carga el entrenamiento del día'));
    return;
  }
  const ready = await ensureDevicesReady();
  if (!ready) return;
  el.start.disabled = true;
  el.start.classList.remove('primary');
  try {
    el.countdownOverlay.classList.remove('hidden');
    for (let n = 5; n >= 1; n -= 1) {
      el.countdownNumber.textContent = String(n);
      el.countdownNumber.style.animation = 'none';
      void el.countdownNumber.offsetWidth; // fuerza reflow para reiniciar la animación cada tick
      el.countdownNumber.style.animation = '';
      await sleep(1000);
    }
    el.countdownOverlay.classList.add('hidden');
    await startSession();
  } catch (err) {
    el.countdownOverlay.classList.add('hidden');
    el.start.disabled = false;
    el.start.classList.add('primary');
    throw err;
  }
}

async function startSession() {
  currentIntervalIndex = 0;
  intervalElapsed = 0;
  sessionElapsed = 0;
  sessionStartedAt = new Date();
  zeroPowerStreak = 0;
  session = { powerSamples: [], hrSamples: [], cadenceSamples: [] };
  displayPowerBuffer = [];
  resetChart();
  sessionState = 'running';
  pauseReason = null;
  el.pauseToggle.disabled = false;
  el.pauseToggle.textContent = '⏸';
  refreshCharts();
  // El control ERG solo existe si hay un Simulador FTMS conectado; con solo un
  // potenciómetro/biela como fuente de potencia, la sesión corre sin control de resistencia.
  if (ble.state.connected.trainer) await ble.startWorkout();
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
  const target = scaleTarget(interval);
  el.target.textContent = target;
  if (ble.state.connected.trainer) await ble.setTargetPower(target);
}

function pauseSession(reason) {
  if (sessionState !== 'running') return;
  clearInterval(timer);
  sessionState = 'paused';
  pauseReason = reason;
  el.pauseToggle.textContent = '▶';
  const message =
    reason === 'auto' ? 'En pausa: no se detecta potencia.' : 'Entrenamiento en pausa.';
  el.status.textContent = message;
  showToast(message, 'pause', true); // persistente: se mantiene visible mientras dure la pausa
}

async function resumeSession(reason) {
  if (sessionState !== 'paused') return;
  if (reason === 'auto' && pauseReason !== 'auto') return; // no reanuda solo una pausa manual
  sessionState = 'running';
  pauseReason = null;
  zeroPowerStreak = 0;
  el.pauseToggle.textContent = '⏸';
  await applyCurrentInterval();
  timer = setInterval(tick, 1000);
  el.status.textContent = 'Entrenamiento en curso.';
  hideToast();
  showToast('Entrenamiento reanudado.');
}

function tick() {
  const power = getSelectedPower(ble.state) ?? 0;

  if (power === 0) {
    zeroPowerStreak += 1;
    if (zeroPowerStreak >= ZERO_POWER_STREAK_TO_AUTOPAUSE) {
      pauseSession('auto');
      return;
    }
  } else {
    zeroPowerStreak = 0;
  }

  sessionElapsed += 1;
  intervalElapsed += 1;

  const hr = ble.state.heartRate ?? 0;
  const cadence = ble.state.cadence ?? ble.state.trainerCadence ?? 0;

  session.powerSamples.push(power);
  session.hrSamples.push(hr);
  session.cadenceSamples.push(cadence);
  pushSample(sessionElapsed, power, hr);

  updateTimeDisplays();
  renderZoom(zoomChart, getScaledIntervals(), currentFTP, sessionElapsed, hydrationReminders);
  renderActualTrace(profileChart, session.powerSamples, session.hrSamples);
  renderActualTrace(zoomChart, session.powerSamples, session.hrSamples);
  setPlayhead(profileChart, sessionElapsed);
  setPlayhead(zoomChart, sessionElapsed);

  const interval = workout.intervals[currentIntervalIndex];
  if (interval && intervalElapsed >= interval.duration) {
    currentIntervalIndex += 1;
    intervalElapsed = 0;
    applyCurrentInterval().catch(showError);
  } else if (sessionElapsed % ERG_REFRESH_SECONDS === 0) {
    reapplyCurrentTarget();
  }
}

// Reenvía el target ERG vigente cada pocos segundos aunque no haya cambiado de intervalo.
// Algunos rodillos "sueltan" la resistencia si no reciben el comando de nuevo con cierta
// frecuencia -- esto lo mantiene firme sin depender de un control propio en la app (el
// ajuste fino de resistencia vs. potencia real ya lo hace el firmware del rodillo en modo
// ERG). Los fallos se ignoran en silencio: es un refuerzo de fondo, no la aplicación real
// del intervalo (esa sí reporta error en applyCurrentInterval).
function reapplyCurrentTarget() {
  const interval = workout.intervals[currentIntervalIndex];
  if (!interval) return;
  ble.setTargetPower(scaleTarget(interval)).catch(() => {});
}

function formatMMSS(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function updateTimeDisplays() {
  const interval = workout.intervals[currentIntervalIndex];
  const remaining = interval ? interval.duration - intervalElapsed : 0;
  el.intervalTime.textContent = formatMMSS(remaining);
  el.totalTime.textContent = formatMMSS(sessionElapsed);

  const totalDuration = workout.intervals.reduce((sum, i) => sum + i.duration, 0);
  const remainingTotal = Math.max(0, totalDuration - sessionElapsed);
  const endTime = new Date(Date.now() + remainingTotal * 1000);
  el.endTime.textContent = endTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
}

function updatePairedCount() {
  const count = Object.values(ble.state.connected).filter(Boolean).length;
  el.pairedCount.textContent = `${count} Paired`;
  el.pairedCount.classList.toggle('has-devices', count > 0);
}

// TSS (Training Stress Score, método de Coggan): (duración_s × NP × IF) / (FTP × 3600) × 100,
// con IF (Intensity Factor) = NP / FTP. Sin FTP registrado no se puede calcular.
function computeTSS(durationSec, normalizedPower, ftpValue) {
  if (!ftpValue) return '';
  const intensityFactor = normalizedPower / ftpValue;
  return Math.round(((durationSec * normalizedPower * intensityFactor) / (ftpValue * 3600)) * 100);
}

async function saveSummary() {
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
  const normalizedPower = computeNormalizedPower(session.powerSamples);
  const summary = {
    date: new Date().toISOString().slice(0, 10),
    workoutName: workout?.name ?? 'Sesión libre',
    durationSec: sessionElapsed,
    avgPower: avg(session.powerSamples),
    normalizedPower,
    avgHeartRate: avg(session.hrSamples),
    avgCadence: avg(session.cadenceSamples),
    tss: computeTSS(sessionElapsed, normalizedPower, currentFTP),
  };
  await history.appendSessionSummary(SPREADSHEET_ID, summary);

  // Strava es "además de" Sheets, no "en vez de": si falla, se avisa pero no se
  // deshace ni bloquea el guardado en Sheets, que ya quedó hecho arriba.
  if (strava.isConnected()) {
    try {
      await strava.uploadActivity({
        name: summary.workoutName,
        startedAt: sessionStartedAt ?? new Date(Date.now() - sessionElapsed * 1000),
        powerSamples: session.powerSamples,
        hrSamples: session.hrSamples,
        cadenceSamples: session.cadenceSamples,
      });
    } catch (err) {
      showAlert(`Se guardó en Sheets, pero falló la subida a Strava: ${err.message}`);
    }
  }
}

const SAVED_MESSAGE = 'Muy buen esfuerzo, el entrenamiento ha sido guardado en tu historial.';

// Cierre natural: se acabaron todos los intervalos del plan. Pregunta antes de guardar.
async function finishSession() {
  clearInterval(timer);
  sessionState = 'finished';
  const wantsSave = await askSaveToHistory();
  if (wantsSave) {
    await saveSummary();
    el.status.textContent = SAVED_MESSAGE;
    resetToIdle();
    showToast(SAVED_MESSAGE);
  } else {
    el.status.textContent = 'Entrenamiento finalizado sin guardar.';
    resetToIdle();
  }
}

// Menú "..." -> Guardar y cerrar: guarda el progreso parcial y cierra la sesión.
async function saveAndClose() {
  if (sessionState === 'idle' || sessionState === 'finished') return;
  clearInterval(timer);
  await ble.stopWorkout().catch(() => {});
  await saveSummary();
  el.status.textContent = SAVED_MESSAGE;
  resetToIdle();
  showToast(SAVED_MESSAGE);
}

// Menú "..." -> Descartar y cerrar: borra el progreso sin guardar nada.
async function discardAndClose() {
  if (sessionState === 'idle' || sessionState === 'finished') return;
  if (!confirm('¿Descartar el entrenamiento en curso? Se perderá el progreso.')) return;
  clearInterval(timer);
  await ble.stopWorkout().catch(() => {});
  el.status.textContent = 'Entrenamiento descartado.';
  resetToIdle();
}

function resetToIdle() {
  sessionState = 'idle';
  pauseReason = null;
  zeroPowerStreak = 0;
  el.pauseToggle.disabled = true;
  el.pauseToggle.textContent = '⏸';
  el.start.disabled = false;
  el.start.classList.add('primary');
  hideToast();
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

function showError(err) {
  console.error(err);
  showAlert(err.message);
}
