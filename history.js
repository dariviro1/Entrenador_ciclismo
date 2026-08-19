// history.js
// Guardado del resumen de cada sesión de entrenamiento en la pestaña "Historial".

import { appendRow } from './sheets.js';

const SHEET = 'Historial';

export async function appendSessionSummary(spreadsheetId, summary) {
  await appendRow(spreadsheetId, SHEET, [
    summary.date,
    summary.workoutName,
    summary.durationSec,
    summary.avgPower,
    summary.normalizedPower,
    summary.avgHeartRate,
    summary.avgCadence,
    summary.tss ?? '',
  ]);
}
