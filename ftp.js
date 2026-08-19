// ftp.js
// Cálculo y progresión de FTP (potencia funcional de umbral), guardado en la pestaña "FTP".
// Columnas esperadas: A fecha · B ftp (vatios) · C motivo (ej. "test 20min", "manual", "ramp test").

import { getSheetValues, appendRow } from './sheets.js';

const FTP_SHEET = 'FTP';
const HISTORY_SHEET = 'Historial';

// Lee el FTP vigente: la entrada más reciente por fecha en la pestaña "FTP".
export async function getCurrentFTP(spreadsheetId) {
  const rows = await getSheetValues(spreadsheetId, `${FTP_SHEET}!A2:C1000`);
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => new Date(a[0]) - new Date(b[0]));
  const last = sorted[sorted.length - 1];
  return { date: last[0], ftp: Number(last[1]), reason: last[2] };
}

// Registra un nuevo valor de FTP con la fecha de hoy y el motivo (test, ajuste, etc.).
export async function recordFTP(spreadsheetId, ftpValue, reason = 'manual') {
  const date = new Date().toISOString().slice(0, 10);
  await appendRow(spreadsheetId, FTP_SHEET, [date, ftpValue, reason]);
  return { date, ftp: ftpValue, reason };
}

// Estimación estándar a partir de un test de 20 minutos: FTP ≈ 95% de la potencia media del test.
export function estimateFromTwentyMinTest(avgPower20min) {
  return Math.round(avgPower20min * 0.95);
}

// Estimación a partir de un ramp test clásico (a fallo): FTP ≈ 75% de la mejor potencia sostenida 1 minuto.
// Es el protocolo que genera el generador de planes de Google Sheets (apps-script/Code.gs,
// función ftpRampTestIntervals_): escalones de 1 minuto que suben 5%FTP cada uno hasta
// que ya no puedas sostenerlos. Usa la potencia media del último escalón COMPLETO que
// hayas terminado como el "bestOneMinPower" de esta función.
export function estimateFromRampTest(bestOneMinPower) {
  return Math.round(bestOneMinPower * 0.75);
}

// Heurística simple de progresión: compara la potencia normalizada de las últimas sesiones
// contra el FTP vigente. No sustituye un test real -- es una señal de si el FTP guardado
// se quedó corto o largo frente a lo que de hecho estás sosteniendo. Para más precisión,
// lo ideal sería comparar contra el "intensity factor" planeado de cada entrenamiento
// en vez del FTP crudo (requeriría guardar ese dato también en el historial).
export async function suggestFTPAdjustment(spreadsheetId, currentFTP, lookback = 5) {
  const rows = await getSheetValues(spreadsheetId, `${HISTORY_SHEET}!A2:H1000`);
  const recent = rows.slice(-lookback);
  if (recent.length < 3) return { suggestion: 'datos-insuficientes' };

  let over = 0;
  let under = 0;
  for (const row of recent) {
    const normalizedPower = Number(row[4]);
    if (!normalizedPower) continue;
    const ratio = normalizedPower / currentFTP;
    if (ratio > 1.05) over += 1;
    if (ratio < 0.85) under += 1;
  }

  const threshold = Math.ceil(recent.length * 0.6);
  if (over >= threshold) return { suggestion: 'subir', newFTP: Math.round(currentFTP * 1.03) };
  if (under >= threshold) return { suggestion: 'bajar', newFTP: Math.round(currentFTP * 0.97) };
  return { suggestion: 'mantener', newFTP: currentFTP };
}

// Convierte intervalos definidos en %FTP a vatios absolutos usando el FTP vigente.
// Los intervalos ya definidos en vatios fijos (targetPower) se dejan tal cual.
export function resolveIntervalsToWatts(intervals, ftp) {
  return intervals.map((interval) => {
    if (interval.targetPower != null) return interval;
    if (interval.targetFTPPercent != null && ftp) {
      return { ...interval, targetPower: Math.round((interval.targetFTPPercent / 100) * ftp) };
    }
    throw new Error('Intervalo sin targetPower ni targetFTPPercent, o FTP no definido');
  });
}
