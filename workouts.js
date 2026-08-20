// workouts.js
// Lectura y escritura de entrenamientos en la pestaña "Calendario".

import { getSheetValues, appendRow, updateRow } from './sheets.js';
import { computeHydration, weightedAvgIntensity, formatHydration } from './hydration.js';

const SHEET = 'Calendario';

function computeDurationMinutes(intervals) {
  const totalSec = (intervals || []).reduce((s, i) => s + Number(i.duration || 0), 0);
  return Math.round(totalSec / 60);
}

// Lee el entrenamiento asignado a una fecha específica.
// Columna A: fecha (YYYY-MM-DD) · B: nombre · C: intervalos en JSON ·
// D: duración total en minutos · E: hidratación sugerida (texto).
// D y E se recalculan solos al guardar — no hace falta escribirlos a mano.
// Cada intervalo es {duration, targetPower} (vatios fijos) o
// {duration, targetFTPPercent} (porcentaje del FTP vigente).
export async function getWorkoutForDate(spreadsheetId, dateISO) {
  const rows = await getSheetValues(spreadsheetId, `${SHEET}!A2:E1000`);
  const row = rows.find((r) => r[0] === dateISO);
  if (!row) return null;
  return {
    name: row[1],
    intervals: JSON.parse(row[2] || '[]'),
    durationMin: row[3] || null,
    hydration: row[4] || '',
  };
}

// Lee todos los entrenamientos guardados en el calendario (para el desplegable de
// selección de la app), ordenados por fecha.
export async function getAllWorkouts(spreadsheetId) {
  const rows = await getSheetValues(spreadsheetId, `${SHEET}!A2:E1000`);
  return rows
    .filter((r) => r[0] && r[1])
    .map((r) => ({
      date: r[0],
      name: r[1],
      intervals: JSON.parse(r[2] || '[]'),
      durationMin: r[3] || null,
      hydration: r[4] || '',
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Crea el entrenamiento de una fecha, o lo reemplaza si ya existía uno.
// Usado por el editor de entrenamientos dentro de la app (workout-editor.js).
// La hidratación se calcula con la misma fórmula general de respaldo que usa
// el generador de planes de Google Sheets cuando Claude no participa
// (apps-script/Code.gs, función fallbackHydration_) — ver hydration.js.
export async function upsertWorkoutForDate(spreadsheetId, dateISO, name, intervals) {
  const rows = await getSheetValues(spreadsheetId, `${SHEET}!A2:E1000`);
  const index = rows.findIndex((r) => r[0] === dateISO);
  const durationMin = computeDurationMinutes(intervals);
  const hydrationText = formatHydration(computeHydration(durationMin, weightedAvgIntensity(intervals)));
  const row = [dateISO, name, JSON.stringify(intervals), durationMin, hydrationText];
  if (index === -1) {
    await appendRow(spreadsheetId, SHEET, row);
  } else {
    await updateRow(spreadsheetId, SHEET, index + 2, row); // +2: fila de encabezado + índice base 0
  }
}
