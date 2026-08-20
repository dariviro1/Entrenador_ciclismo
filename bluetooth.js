// bluetooth.js
// Conexión a sensores y rodillo vía Web Bluetooth (BLE), con reconexión automática.
// Requiere Chrome o Edge de escritorio, servidos por HTTPS o localhost.
// Web Bluetooth NO funciona en Safari ni Firefox.

const SERVICE = {
  cyclingPower: 'cycling_power',
  heartRate: 'heart_rate',
  fitnessMachine: 'fitness_machine',
};

const CHAR = {
  cyclingPowerMeasurement: 'cycling_power_measurement',
  heartRateMeasurement: 'heart_rate_measurement',
  indoorBikeData: 0x2ad2,
  ftmsControlPoint: 0x2ad9,
  fitnessMachineFeature: 0x2acc,
  fitnessMachineStatus: 0x2ada,
};

// Opcodes del Fitness Machine Control Point (spec FTMS del Bluetooth SIG)
const FTMS_OPCODE = {
  requestControl: 0x00,
  reset: 0x01,
  setTargetPower: 0x05,
  startOrResume: 0x07,
  stopOrPause: 0x08,
  spinDownControl: 0x13,
  responseCode: 0x80,
};

// Sub-estados del evento "New Spin Down Status" (0x14) en Fitness Machine Status (0x2ADA)
const SPIN_DOWN_STATUS = {
  0x01: 'requested',
  0x02: 'success',
  0x03: 'error',
  0x04: 'stop-pedaling',
};

export const state = {
  power: null,
  cadence: null,
  heartRate: null,
  trainerPower: null,
  trainerCadence: null,
  trainerSpeed: null, // km/h, de Indoor Bike Data -- usado por el velocímetro de calibración
  trainerSpinDownSupported: false, // se llena al conectar el Simulador, ver setupTrainer()
  devices: { powerMeter: null, heartRate: null, trainer: null },
  // Estado real de conexión GATT (a diferencia de `devices`, que solo guarda la
  // referencia del dispositivo emparejado y nunca se limpia). Esto es lo que
  // refleja si el sensor sigue realmente conectado ahora mismo.
  connected: { powerMeter: false, heartRate: false, trainer: false },
};

const dataListeners = new Set();
export function onData(cb) {
  dataListeners.add(cb);
}
function notify() {
  dataListeners.forEach((cb) => cb(state));
}

const statusListeners = new Set();
export function onStatus(cb) {
  statusListeners.add(cb);
}
function notifyStatus(message) {
  statusListeners.forEach((cb) => cb(message));
}

const connectionListeners = new Set();
export function onConnectionChange(cb) {
  connectionListeners.add(cb);
}
function notifyConnectionChange() {
  connectionListeners.forEach((cb) => cb(state.connected));
}

// Sub-estados del procedimiento de calibración por spin down: 'requested' | 'success' |
// 'error' | 'stop-pedaling'. Ver SPIN_DOWN_STATUS más arriba.
const spinDownListeners = new Set();
export function onSpinDownStatus(cb) {
  spinDownListeners.add(cb);
}
function notifySpinDownStatus(subStatus) {
  spinDownListeners.forEach((cb) => cb(subStatus));
}

// Reintenta reconectar un dispositivo BLE ya emparejado (device.gatt.connect() se puede
// volver a llamar sin gesto del usuario; requestDevice() sí lo exige, por eso no se repite).
// Backoff simple hasta maxAttempts. onReconnected es opcional: útil para, por ejemplo,
// reaplicar la potencia objetivo vigente en el rodillo tras reconectarlo.
function attachAutoReconnect(device, label, connectedKey, setupFn, onReconnected) {
  device.addEventListener('gattserverdisconnected', () => {
    state.connected[connectedKey] = false;
    notifyConnectionChange();
    notifyStatus(`${label} desconectado. Reconectando...`);
    let attempt = 0;
    const maxAttempts = 5;
    const retry = async () => {
      attempt += 1;
      try {
        await setupFn(device);
        notifyStatus(`${label} reconectado.`);
        if (onReconnected) onReconnected();
      } catch (err) {
        if (attempt < maxAttempts) {
          setTimeout(retry, Math.min(2000 * attempt, 10000));
        } else {
          notifyStatus(`No se pudo reconectar ${label} tras ${maxAttempts} intentos. Reconéctalo manualmente.`);
        }
      }
    };
    retry();
  });
}

// --- Potenciómetro (Cycling Power Service) ---
export async function connectPowerMeter() {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICE.cyclingPower] }],
  });
  await setupPowerMeter(device);
  attachAutoReconnect(device, 'Potenciómetro', 'powerMeter', setupPowerMeter);
  state.devices.powerMeter = device;
  return device;
}

async function setupPowerMeter(device) {
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE.cyclingPower);
  const char = await service.getCharacteristic(CHAR.cyclingPowerMeasurement);
  await char.startNotifications();
  char.addEventListener('characteristicvaluechanged', handlePowerMeasurement);
  state.connected.powerMeter = true;
  notifyConnectionChange();
}

let lastCrank = null;
const MAX_PLAUSIBLE_CADENCE = 220; // rpm; por encima de esto, es ruido del sensor, no pedaleo real

function handlePowerMeasurement(event) {
  const value = event.target.value;
  const flags = value.getUint16(0, true);

  // Instantaneous Power siempre está en los bytes 2-3 (sint16, little-endian).
  state.power = value.getInt16(2, true);

  // El resto de campos son opcionales y aparecen en este orden fijo si sus bits
  // de flags están presentes, así que hay que sumar sus tamaños para encontrar
  // el offset real de Crank Revolution Data (spec Cycling Power Measurement).
  let offset = 4; // flags (2) + instantaneous power (2)
  if (flags & 0x0001) offset += 1; // Pedal Power Balance Present (uint8)
  if (flags & 0x0004) offset += 2; // Accumulated Torque Present (uint16)
  if (flags & 0x0010) offset += 6; // Wheel Revolution Data Present (uint32 + uint16)

  const crankRevPresent = (flags & 0x0020) !== 0; // bit 5
  if (crankRevPresent) {
    const cumulativeCrankRevs = value.getUint16(offset, true);
    const lastCrankEventTime = value.getUint16(offset + 2, true); // en 1/1024 s
    state.cadence = computeCadence(cumulativeCrankRevs, lastCrankEventTime);
  }
  notify();
}

function computeCadence(revs, eventTime) {
  if (!lastCrank) {
    lastCrank = { revs, eventTime };
    return state.cadence;
  }
  let deltaRevs = revs - lastCrank.revs;
  let deltaTime = eventTime - lastCrank.eventTime;
  if (deltaTime < 0) deltaTime += 65536; // overflow del contador de 16 bits
  if (deltaRevs < 0) deltaRevs += 65536;
  lastCrank = { revs, eventTime };
  if (deltaTime === 0) return state.cadence;
  const cadence = Math.round((deltaRevs / (deltaTime / 1024)) * 60);
  // Un solo evento con deltaTime muy chico (dos notificaciones pegadas) puede dar
  // una cadencia absurda; en ese caso se descarta y se mantiene la última válida.
  return cadence >= 0 && cadence <= MAX_PLAUSIBLE_CADENCE ? cadence : state.cadence;
}

// --- Banda de frecuencia cardíaca (Heart Rate Service) ---
export async function connectHeartRateMonitor() {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICE.heartRate] }],
  });
  await setupHeartRate(device);
  attachAutoReconnect(device, 'Banda de FC', 'heartRate', setupHeartRate);
  state.devices.heartRate = device;
  return device;
}

async function setupHeartRate(device) {
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE.heartRate);
  const char = await service.getCharacteristic(CHAR.heartRateMeasurement);
  await char.startNotifications();
  char.addEventListener('characteristicvaluechanged', (event) => {
    const value = event.target.value;
    const flags = value.getUint8(0);
    const is16bit = (flags & 0x01) !== 0;
    state.heartRate = is16bit ? value.getUint16(1, true) : value.getUint8(1);
    notify();
  });
  state.connected.heartRate = true;
  notifyConnectionChange();
}

// --- Simulador / rodillo inteligente (Fitness Machine Service - FTMS) ---
let ftmsControlChar = null;

// onReconnected: callback opcional que la app puede pasar para, por ejemplo,
// reenviar la potencia objetivo del intervalo actual apenas se recupera la conexión.
export async function connectTrainer(onReconnected) {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICE.fitnessMachine] }],
  });
  await setupTrainer(device);
  attachAutoReconnect(device, 'Simulador', 'trainer', setupTrainer, onReconnected);
  state.devices.trainer = device;
  return device;
}

async function setupTrainer(device) {
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE.fitnessMachine);

  const dataChar = await service.getCharacteristic(CHAR.indoorBikeData);
  await dataChar.startNotifications();
  dataChar.addEventListener('characteristicvaluechanged', handleIndoorBikeData);

  ftmsControlChar = await service.getCharacteristic(CHAR.ftmsControlPoint);
  await ftmsControlChar.startNotifications();
  ftmsControlChar.addEventListener('characteristicvaluechanged', handleControlResponse);

  // Fitness Machine Feature (0x2ACC): lectura única (no notify) para saber si el
  // Simulador soporta spin-down antes de ofrecer la opción de calibrar. Bit 7 (0x80)
  // del byte 5 = "Spin Down Control Supported" (spec FTMS, Target Setting Features).
  try {
    const featureChar = await service.getCharacteristic(CHAR.fitnessMachineFeature);
    const featureValue = await featureChar.readValue();
    state.trainerSpinDownSupported = (featureValue.getUint8(5) & 0x80) !== 0;
  } catch (err) {
    state.trainerSpinDownSupported = false;
  }

  // Fitness Machine Status (0x2ADA): notificaciones de progreso, entre ellas las del
  // procedimiento de spin-down (evento 0x14).
  const statusChar = await service.getCharacteristic(CHAR.fitnessMachineStatus);
  await statusChar.startNotifications();
  statusChar.addEventListener('characteristicvaluechanged', handleFitnessMachineStatus);

  await requestControl();
  state.connected.trainer = true;
  notifyConnectionChange();
}

function handleFitnessMachineStatus(event) {
  const value = event.target.value;
  const eventCode = value.getUint8(0);
  if (eventCode === 0x14) {
    const subStatus = SPIN_DOWN_STATUS[value.getUint8(1)];
    if (subStatus) notifySpinDownStatus(subStatus);
  }
}

function handleIndoorBikeData(event) {
  const value = event.target.value;
  const flags = value.getUint16(0, true);
  let offset = 2;

  if ((flags & 0x0001) === 0) {
    state.trainerSpeed = value.getUint16(offset, true) / 100; // km/h, resolución 0.01
    offset += 2;
  }
  if (flags & 0x0002) offset += 2; // average speed
  if (flags & 0x0004) {
    state.trainerCadence = value.getUint16(offset, true) / 2; // resolución 0.5 rpm
    offset += 2;
  }
  if (flags & 0x0008) offset += 2; // average cadence
  if (flags & 0x0010) offset += 3; // total distance (uint24)
  if (flags & 0x0020) offset += 2; // resistance level
  if (flags & 0x0040) {
    state.trainerPower = value.getInt16(offset, true);
    offset += 2;
  }
  notify();
}

async function sendControlCommand(bytes) {
  if (!ftmsControlChar) throw new Error('Simulador no conectado');
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  await ftmsControlChar.writeValueWithResponse(data);
}

async function requestControl() {
  await sendControlCommand([FTMS_OPCODE.requestControl]);
}

export async function startWorkout() {
  await sendControlCommand([FTMS_OPCODE.startOrResume]);
}

export async function stopWorkout() {
  await sendControlCommand([FTMS_OPCODE.stopOrPause]);
}

// Fija la potencia objetivo del rodillo en vatios (modo ERG).
export async function setTargetPower(watts) {
  const buffer = new ArrayBuffer(3);
  const view = new DataView(buffer);
  view.setUint8(0, FTMS_OPCODE.setTargetPower);
  view.setInt16(1, Math.round(watts), true); // little-endian
  await sendControlCommand(new Uint8Array(buffer));
}

// Calibración por spin-down: el firmware del Simulador mide la desaceleración y calcula
// la calibración; nosotros solo iniciamos/cancelamos el procedimiento. El progreso llega
// por onSpinDownStatus(). Solo tiene sentido llamarlo si state.trainerSpinDownSupported.
export async function startSpinDown() {
  await sendControlCommand([FTMS_OPCODE.spinDownControl, 0x01]);
}

export async function cancelSpinDown() {
  await sendControlCommand([FTMS_OPCODE.spinDownControl, 0x02]);
}

function handleControlResponse(event) {
  const value = event.target.value;
  const opcode = value.getUint8(0);
  if (opcode === FTMS_OPCODE.responseCode) {
    const requestOpcode = value.getUint8(1);
    const resultCode = value.getUint8(2); // 0x01 = éxito
    if (resultCode !== 0x01) {
      console.warn(`Comando FTMS ${requestOpcode} falló, código de resultado:`, resultCode);
    }
  }
}
