// cyclist.js
// Lee el perfil del ciclista desde la pestaña "Ciclista" -- la misma que ya usa el
// generador de planes en Google Sheets (apps-script/Code-sheet.gs, getCyclistProfile_()).
// Layout de la pestaña: etiqueta en columna A, valor en columna B (una fila por dato),
// así que agregar o quitar filas no rompe nada -- se busca por texto de etiqueta, no por
// número de fila fijo. Se usa para calibrar dinámicamente el techo de las escalas de
// potencia y FC en las gráficas (ver profilechart.js/livechart.js).

import { getSheetValues } from './sheets.js';

const SHEET = 'Ciclista';

export async function getCyclistProfile(spreadsheetId) {
  const rows = await getSheetValues(spreadsheetId, `${SHEET}!A1:B50`);
  const map = {};
  rows.forEach((row) => {
    const label = String(row[0] || '').trim();
    if (label) map[label] = row[1];
  });
  return {
    name: map['Nombre'] || '',
    weightKg: Number(map['Peso (kg)']) || null,
    heightCm: Number(map['Estatura (cm)']) || null,
    hrMax: Number(map['FC máxima (bpm)']) || null,
    hrRest: Number(map['FC en reposo (bpm)']) || null,
    level: map['Nivel'] || '',
    ftp: Number(map['FTP vigente (W)']) || null,
  };
}
