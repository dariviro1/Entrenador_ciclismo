// workout-editor.js
// UI para crear/editar el entrenamiento de una fecha, sin tener que escribir el JSON
// de intervalos a mano en la celda de Google Sheets.

import { getWorkoutForDate, upsertWorkoutForDate } from './workouts.js';

let spreadsheetId = null;
let rowIdCounter = 0;
const el = {};

export function initWorkoutEditor(id) {
  spreadsheetId = id;
  el.date = document.getElementById('editor-date');
  el.name = document.getElementById('editor-name');
  el.rows = document.getElementById('editor-rows');
  el.status = document.getElementById('editor-status');

  el.date.value = new Date().toISOString().slice(0, 10);

  document.getElementById('editor-add-row').onclick = () => addRow();
  document.getElementById('editor-load').onclick = () => loadForDate().catch(showError);
  document.getElementById('editor-save').onclick = () => saveWorkout().catch(showError);

  addRow({ duration: 600, mode: 'watts', value: 150 });
}

function addRow(prefill = { duration: 300, mode: 'watts', value: 150 }) {
  const id = `row-${rowIdCounter++}`;
  const row = document.createElement('div');
  row.className = 'editor-row';
  row.dataset.id = id;
  row.innerHTML = `
    <input type="number" class="e-duration" min="1" value="${Math.round(prefill.duration / 60)}" title="minutos">
    <select class="e-mode">
      <option value="watts" ${prefill.mode === 'watts' ? 'selected' : ''}>Vatios</option>
      <option value="ftp" ${prefill.mode === 'ftp' ? 'selected' : ''}>% FTP</option>
    </select>
    <input type="number" class="e-value" min="1" value="${prefill.value}">
    <button type="button" class="e-remove" aria-label="Quitar intervalo">×</button>
  `;
  row.querySelector('.e-remove').onclick = () => row.remove();
  el.rows.appendChild(row);
}

async function loadForDate() {
  const dateISO = el.date.value;
  el.status.textContent = 'Buscando entrenamiento...';
  const workout = await getWorkoutForDate(spreadsheetId, dateISO);
  el.rows.innerHTML = '';
  if (!workout) {
    el.name.value = '';
    addRow();
    el.status.textContent = 'No había entrenamiento para esa fecha. Empezando uno nuevo.';
    return;
  }
  el.name.value = workout.name;
  workout.intervals.forEach((interval) => {
    if (interval.targetFTPPercent != null) {
      addRow({ duration: interval.duration, mode: 'ftp', value: interval.targetFTPPercent });
    } else {
      addRow({ duration: interval.duration, mode: 'watts', value: interval.targetPower });
    }
  });
  el.status.textContent = 'Entrenamiento cargado para editar.';
}

async function saveWorkout() {
  const dateISO = el.date.value;
  const name = el.name.value.trim();
  if (!name) throw new Error('Ponle un nombre al entrenamiento');

  const intervals = [...el.rows.querySelectorAll('.editor-row')].map((row) => {
    const minutes = Number(row.querySelector('.e-duration').value);
    const mode = row.querySelector('.e-mode').value;
    const value = Number(row.querySelector('.e-value').value);
    const duration = Math.round(minutes * 60);
    return mode === 'ftp' ? { duration, targetFTPPercent: value } : { duration, targetPower: value };
  });

  if (!intervals.length) throw new Error('Agrega al menos un intervalo');

  el.status.textContent = 'Guardando...';
  await upsertWorkoutForDate(spreadsheetId, dateISO, name, intervals);
  el.status.textContent = `Guardado: "${name}" para ${dateISO}.`;
}

function showError(err) {
  console.error(err);
  el.status.textContent = `Error: ${err.message}`;
}
