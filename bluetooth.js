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
};

// Opcodes del Fitness Machine Control Point (spec FTMS del Bluetooth SIG)
const FTMS_OPCODE = {
  requestControl: 0x00,
  reset: 0x01,
  setTargetPower: 0x05,
  startOrResume: 0x07,
  stopOrPause: 0x08,
  responseCode: 0x80,
};

export const state = {
  power: null,
  cadence: null,
  heartRate: null,
  trainerPower: null,
  trainerCadence: null,
  devices: { powerMeter: null, heartRate: null, trainer: null },
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

// Reintenta reconectar un dispositivo BLE ya emparejado (device.gatt.connect() se puede
// volver a llamar sin gesto del usuario; requestDevice() sí lo exige, por eso no se repite).
// Backoff simple hasta maxAttempts. onReconnected es opcional: útil para, por ejemplo,
// reaplicar la potencia objetivo vigente en el rodillo tras reconectarlo.
function attachAutoReconnect(device, label, setupFn, onReconnected) {
  device.addEventListener('gattserverdisconnected', () => {
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
  attachAutoReconnect(device, 'Potenciómetro', setupPowerMeter);
  state.devices.powerMeter = device;
  return device;
}

async function setupPowerMeter(device) {
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE.cyclingPower);
  const char = await service.getCharacteristic(CHAR.cyclingPowerMeasurement);
  await char.startNotifications();
  char.addEventListener('characteristicvaluechanged', handlePowerMeasurement);
}

let lastCrank = null;

function handlePowerMeasurement(event) {
  const value = event.target.value;
  const flags = value.getUint16(0, true);

  // Instantaneous Power siempre está en los bytes 2-3 (sint16, little-endian).
  state.power = value.getInt16(2, true);

  // Bit 5 de flags: presencia de "Crank Revolution Data" (para derivar cadencia).
  // El offset exacto depende de qué otros campos opcionales vengan antes según los flags
  // (ej. Pedal Power Balance, Accumulated Torque, Wheel Revolution Data). Aquí se asume
  // el caso más común de un potenciómetro de biela simple: sin esos campos previos.
  const crankRevPresent = (flags & 0x0020) !== 0;
  if (crankRevPresent) {
    const cumulativeCrankRevs = value.getUint16(4, true);
    const lastCrankEventTime = value.getUint16(6, true); // en 1/1024 s
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
  return Math.round((deltaRevs / (deltaTime / 1024)) * 60);
}

// --- Banda de frecuencia cardíaca (Heart Rate Service) ---
export async function connectHeartRateMonitor() {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICE.heartRate] }],
  });
  await setupHeartRate(device);
  attachAutoReconnect(device, 'Banda de FC', setupHeartRate);
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
}

// --- Rodillo / simulador (Fitness Machine Service - FTMS) ---
let ftmsControlChar = null;

// onReconnected: callback opcional que la app puede pasar para, por ejemplo,
// reenviar la potencia objetivo del intervalo actual apenas se recupera la conexión.
export async function connectTrainer(onReconnected) {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICE.fitnessMachine] }],
  });
  await setupTrainer(device);
  attachAutoReconnect(device, 'Rodillo', setupTrainer, onReconnected);
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

  await requestControl();
}

function handleIndoorBikeData(event) {
  const value = event.target.value;
  const flags = value.getUint16(0, true);
  let offset = 2;

  if ((flags & 0x0001) === 0) offset += 2; // instantaneous speed presente si bit0 = 0
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
  if (!ftmsControlChar) throw new Error('Rodillo no conectado');
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
