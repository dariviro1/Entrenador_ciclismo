/**
 * Code.gs
 * Agrega un menú a Google Sheets ("🚴 Plan de entrenamiento") con el botón
 * "Create My Custom Plan": abre un wizard, arma el andamiaje del calendario
 * de forma determinística (fechas, fases de periodización, días de test de FTP),
 * le pide a Claude que rellene los entrenamientos de cada fecha en base al
 * perfil/historial del ciclista, y escribe todo en la pestaña "Calendario".
 */

const CLAUDE_MODEL = 'claude-sonnet-5'; // cambia aquí si quieres usar otro modelo
const API_KEY_PROPERTY = 'CLAUDE_API_KEY';
const MAX_PLAN_WEEKS = 16; // límite práctico por tamaño de respuesta de la API

// Mapeo de "Training Approach" a parámetros de periodización.
// Esto es una asunción de diseño propia (no un estándar fijo): cadencia de test
// de FTP, frecuencia de semana de descarga, y una nota cualitativa de intensidad
// que se le pasa a Claude como guía, no como regla estricta. Ajústalo a gusto.
const APPROACHES = {
  Conservative: {
    recoveryEvery: 3,
    ftpTestEveryWeeks: 8,
    intensityNote: 'Mayormente Z1-Z2 (resistencia aeróbica). Como mucho 1 sesión dura por semana. Progresión de carga suave.',
  },
  Moderate: {
    recoveryEvery: 4,
    ftpTestEveryWeeks: 6,
    intensityNote: '70-80% del tiempo en Z1-Z2, 1-2 sesiones duras por semana (tempo/umbral). Progresión gradual.',
  },
  Balanced: {
    recoveryEvery: 4,
    ftpTestEveryWeeks: 6,
    intensityNote: 'Enfoque polarizado ~80/20: la mayoría del volumen en Z1-Z2, 2 sesiones duras por semana (umbral/VO2max).',
  },
  Demanding: {
    recoveryEvery: 3,
    ftpTestEveryWeeks: 4,
    intensityNote: '2-3 sesiones duras por semana, mayor proporción de umbral/VO2max, progresión de carga más rápida.',
  },
  Aggressive: {
    recoveryEvery: 3,
    ftpTestEveryWeeks: 3,
    intensityNote: '3+ sesiones duras por semana, alta intensidad frecuente. Solo para ciclistas con base aeróbica sólida.',
  },
};

// Composición del sobre de hidratante que usa el ciclista (dato de la etiqueta).
// Los mg de sodio y potasio ELEMENTAL no vienen en la etiqueta, así que se derivan
// de la masa molar de cada sal para darle a Claude una referencia real y no que
// adivine el aporte de electrolitos:
//   - Citrato de sodio dihidratado (Na3C6H5O7·2H2O, ~294.1 g/mol): 23.45% Na →  2.9 g × 0.2345 ≈ 0.680 g
//   - Cloruro de sodio (NaCl, 58.44 g/mol): 39.34% Na                      →  2.6 g × 0.3934 ≈ 1.023 g
//   - Cloruro de potasio (KCl, 74.55 g/mol): 52.45% K                      →  1.5 g × 0.5245 ≈ 0.787 g
const SACHET = {
  gramsTotal: 20.7,
  carbsG: 13.5, // dextrosa anhidra
  sodiumMg: 1703, // sodio elemental total (citrato + cloruro de sodio)
  potassiumMg: 787, // potasio elemental (cloruro de potasio)
};

// ---------------------------------------------------------------------------
// Menú y UI
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🚴 Plan de entrenamiento')
    .addItem('Create My Custom Plan', 'showPlanWizard')
    .addItem('Configurar clave de API de Claude', 'promptApiKey')
    .addToUi();
}

function promptApiKey() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt(
    'Clave de API de Claude',
    'Pega tu clave de api.anthropic.com (Console → API Keys). Se guarda de forma privada ' +
      'en las propiedades de este documento, nunca en el código ni visible para otros.',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const key = res.getResponseText().trim();
  if (!key) return;
  PropertiesService.getScriptProperties().setProperty(API_KEY_PROPERTY, key);
  ui.alert('Clave guardada.');
}

function showPlanWizard() {
  const html = HtmlService.createHtmlOutputFromFile('PlanWizard').setWidth(620).setHeight(720);
  SpreadsheetApp.getUi().showModalDialog(html, 'Create My Custom Plan');
}

// ---------------------------------------------------------------------------
// Lectura de datos de las pestañas del sheet
// ---------------------------------------------------------------------------

// Lee una hoja de layout "etiqueta en columna A / valor en columna B" y devuelve
// un mapa {etiqueta: valor}. Robusto a que se agreguen o quiten filas, porque
// busca por texto de la etiqueta en vez de asumir números de fila fijos.
function readLabeledValues_(sheet) {
  const values = sheet.getDataRange().getValues();
  const map = {};
  values.forEach((row) => {
    const label = String(row[0] || '').trim();
    if (label) map[label] = row[1];
  });
  return map;
}

function getCyclistProfile_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Ciclista');
  if (!sheet) throw new Error('No se encontró la pestaña "Ciclista".');
  const map = readLabeledValues_(sheet);
  return {
    nombre: map['Nombre'] || '',
    fechaNacimiento: map['Fecha de nacimiento (AAAA-MM-DD)'] || '',
    pesoKg: Number(map['Peso (kg)']) || null,
    estaturaCm: Number(map['Estatura (cm)']) || null,
    fcMax: Number(map['FC máxima (bpm)']) || null,
    fcReposo: Number(map['FC en reposo (bpm)']) || null,
    nivel: map['Nivel'] || '',
    ftpVigente: Number(map['FTP vigente (W)']) || null,
  };
}

function getRecentHistory_(limit) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Historial');
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  const rows = values.slice(1).filter((r) => r[0]);
  const recent = rows.slice(-limit);
  return recent.map((r) => ({
    fecha: r[0],
    entrenamiento: r[1],
    duracionSeg: r[2],
    potenciaMedia: r[3],
    potenciaNormalizada: r[4],
    fcMedia: r[5],
    cadenciaMedia: r[6],
    tss: r[7],
  }));
}

function getFTPHistory_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('FTP');
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  return values
    .slice(1)
    .filter((r) => r[0])
    .map((r) => ({ fecha: r[0], ftp: r[1], motivo: r[2] }));
}

// Contexto para prellenar el wizard (FTP vigente, fecha de hoy, etc.)
function getWizardContext() {
  const profile = getCyclistProfile_();
  return {
    ftpVigente: profile.ftpVigente,
    nombre: profile.nombre,
    todayISO: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
  };
}

// ---------------------------------------------------------------------------
// Construcción determinística del andamiaje del calendario
// ---------------------------------------------------------------------------

function weekdayName_(iso) {
  const names = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
  return names[iso] || '';
}

// isoWeekday: 1=lunes ... 7=domingo. Devuelve la primera fecha en/después de
// `date` que cae en ese día de la semana.
function nextWeekdayOnOrAfter_(date, isoWeekday) {
  const d = new Date(date);
  const current = d.getDay() === 0 ? 7 : d.getDay();
  const delta = (isoWeekday - current + 7) % 7;
  d.setDate(d.getDate() + delta);
  return d;
}

function addWeeks_(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n * 7);
  return d;
}

function toISODate_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// Decide cuántas semanas dura el plan. Si hay evento pero cae más allá del
// límite práctico (MAX_PLAN_WEEKS), genera igual las primeras N semanas pero
// SIN aplicar taper (taperApplies=false) — sería un error tapering 16 semanas
// antes de un evento que en realidad está mucho más lejos. El plan se marca
// como "truncated" para avisarle al ciclista que hay que regenerar más adelante.
function computePlanLength_(startDate, hasEvent, eventDate, weeksIfNoEvent) {
  if (hasEvent) {
    const days = Math.round((new Date(eventDate) - new Date(startDate)) / 86400000);
    const fullWeeksNeeded = Math.max(2, Math.ceil(days / 7));
    if (fullWeeksNeeded <= MAX_PLAN_WEEKS) {
      return { totalWeeks: fullWeeksNeeded, taperApplies: true, truncated: false };
    }
    return { totalWeeks: MAX_PLAN_WEEKS, taperApplies: false, truncated: true };
  }
  const weeks = Math.min(Math.max(2, Number(weeksIfNoEvent) || 6), MAX_PLAN_WEEKS);
  return { totalWeeks: weeks, taperApplies: false, truncated: false };
}

function computePhase_(weekIndex, totalWeeks, taperApplies, recoveryEvery) {
  const weekNum = weekIndex + 1;
  if (taperApplies && weekNum === totalWeeks) return 'taper';
  if (taperApplies && weekNum === totalWeeks - 1 && totalWeeks > 3) return 'peak';
  if (weekNum % recoveryEvery === 0) return 'recovery';
  if (weekNum <= 2) return 'base';
  return 'build';
}

// Arma la lista completa de fechas de entrenamiento (según los días/duraciones
// elegidos en el wizard) con su fase de periodización, decide qué fechas se
// convierten en test de FTP según la cadencia del approach elegido, y siempre
// incluye la fecha de inicio en el plan según lo que el ciclista eligió para
// ese día: 'test' (rampa escalonada de FTP), 'rest' (día de descanso/inicio) o
// 'first-workout' (arrancar directo con un entrenamiento normal).
function buildScaffold_(input) {
  const approachCfg = APPROACHES[input.approach] || APPROACHES.Balanced;
  const lengthInfo = computePlanLength_(input.startDate, input.hasEvent, input.eventDate, input.weeksIfNoEvent);
  const totalWeeks = lengthInfo.totalWeeks;

  const days = input.days.filter((d) => Number(d.durationMin) > 0);

  const slots = [];
  for (let w = 0; w < totalWeeks; w++) {
    const phase = computePhase_(w, totalWeeks, lengthInfo.taperApplies, approachCfg.recoveryEvery);
    days.forEach((d) => {
      const date = addWeeks_(nextWeekdayOnOrAfter_(input.startDate, d.weekday), w);
      slots.push({
        date: toISODate_(date),
        weekday: d.weekday,
        durationMin: Number(d.durationMin),
        week: w + 1,
        phase: phase,
      });
    });
  }

  // La fecha de inicio SIEMPRE queda en el plan. Si por casualidad coincide con
  // uno de los slots semanales normales de la semana 1, se saca de ahí primero
  // para no duplicarla — la acción elegida en el wizard manda sobre ese día.
  const startISO = toISODate_(new Date(input.startDate));
  const dupIndex = slots.findIndex((s) => s.date === startISO);
  if (dupIndex !== -1) slots.splice(dupIndex, 1);

  const week1Phase = computePhase_(0, totalWeeks, lengthInfo.taperApplies, approachCfg.recoveryEvery);
  const forcedTestDates = [];
  let restDayEntry = null;
  // Si por algún motivo el wizard no mandó la acción, se asume "primer entrenamiento"
  // para no perder nunca la fecha de inicio del plan.
  const startDateAction = input.startDateAction || 'first-workout';

  if (startDateAction === 'test') {
    forcedTestDates.push(startISO);
  } else if (startDateAction === 'rest') {
    restDayEntry = { date: startISO };
  } else if (startDateAction === 'first-workout') {
    const startDateObj = new Date(input.startDate);
    const jsWeekday = startDateObj.getDay();
    const isoWeekday = jsWeekday === 0 ? 7 : jsWeekday;
    // Si ese día de la semana ya estaba entre los elegidos en el paso 4, se respeta
    // la duración que configuraste ahí; solo se usa el campo extra del wizard
    // cuando la fecha de inicio cae en un día que no era parte del horario semanal.
    const matchingDay = days.find((d) => d.weekday === isoWeekday);
    const durationMin = matchingDay ? matchingDay.durationMin : Number(input.startDateDurationMin) || 45;
    slots.push({
      date: startISO,
      weekday: isoWeekday,
      durationMin: durationMin,
      week: 1,
      phase: week1Phase,
    });
  }

  slots.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Semanas objetivo para test de FTP periódico (nunca en semana 1 ni en fase taper).
  const testWeekNumbers = [];
  for (let w = approachCfg.ftpTestEveryWeeks + 1; w <= totalWeeks; w += approachCfg.ftpTestEveryWeeks) {
    testWeekNumbers.push(w);
  }
  const periodicTestDates = [];
  testWeekNumbers.forEach((weekNum) => {
    const candidates = slots.filter((s) => s.week === weekNum && s.phase !== 'taper');
    if (!candidates.length) return;
    candidates.sort((a, b) => b.durationMin - a.durationMin);
    periodicTestDates.push(candidates[0].date);
  });

  const testDates = forcedTestDates.concat(periodicTestDates);
  const trainingSlots = slots.filter(
    (s) => testDates.indexOf(s.date) === -1 && (!restDayEntry || s.date !== restDayEntry.date)
  );

  return {
    totalWeeks: totalWeeks,
    taperApplies: lengthInfo.taperApplies,
    truncated: lengthInfo.truncated,
    approachCfg: approachCfg,
    slots: trainingSlots,
    testDates: testDates,
    restDayEntry: restDayEntry,
  };
}

// ---------------------------------------------------------------------------
// Prompt y llamada a la API de Claude
// ---------------------------------------------------------------------------

function buildClaudePrompt_(profile, history, ftpHistory, scaffold, input) {
  const weeklyByWeek = {};
  scaffold.slots.forEach((s) => {
    weeklyByWeek[s.week] = weeklyByWeek[s.week] || [];
    weeklyByWeek[s.week].push(s);
  });

  const weeksText = Object.keys(weeklyByWeek)
    .sort((a, b) => Number(a) - Number(b))
    .map((w) => {
      const items = weeklyByWeek[w];
      const phase = items[0].phase;
      const daysText = items
        .map((s) => `${s.date} (${weekdayName_(s.weekday)}, ${s.durationMin} min)`)
        .join('; ');
      return `Semana ${w} [fase: ${phase}]: ${daysText}`;
    })
    .join('\n');

  const historyText = history.length
    ? history
        .map(
          (h) =>
            `${h.fecha} · ${h.entrenamiento} · ${Math.round((h.duracionSeg || 0) / 60)}min · ` +
            `NP ${h.potenciaNormalizada}W · FC media ${h.fcMedia}`
        )
        .join('\n')
    : '(sin sesiones registradas todavía)';

  const ftpText = ftpHistory.length
    ? ftpHistory.map((f) => `${f.fecha}: ${f.ftp}W (${f.motivo})`).join('\n')
    : '(sin historial de FTP)';

  const eventNote = scaffold.taperApplies
    ? `El ciclista tiene un evento el ${input.eventDate}. Las semanas en fase "peak" y "taper" ` +
      `deben reducir volumen e intensidad para llegar descansado y con piernas frescas.`
    : input.hasEvent
    ? `El ciclista tiene un evento más adelante, pero está fuera del rango de este bloque de ` +
      `${scaffold.totalWeeks} semanas. Este es solo el primer bloque de un plan más largo: ` +
      `NO apliques taper todavía, termina el bloque en fase de construcción normal.`
    : `No hay un evento específico: termina el bloque con una carga manejable, sin taper.`;

  const hydrationText =
    `El ciclista toma sobres de hidratante de ${SACHET.gramsTotal} g. Cada sobre aporta ` +
    `${SACHET.carbsG} g de carbohidratos (dextrosa), ${SACHET.sodiumMg} mg de sodio elemental y ` +
    `${SACHET.potassiumMg} mg de potasio elemental. Como referencia general (no es una regla ` +
    `médica): en ejercicio moderado se pierden ~500-750 ml/hora de sudor, más en sesiones intensas ` +
    `o largas; el sodio perdido ronda 300-700 mg/hora en la mayoría de la gente, más en sudadores ` +
    `salados o calor. Los entrenamientos en rodillo (indoor) suelen sudar más que al aire libre por ` +
    `falta de viento.`;

  return `Eres un entrenador de ciclismo experto en periodización de potencia. Genera un plan de entrenamiento estructurado.

PERFIL DEL CICLISTA
- Nombre: ${profile.nombre || 'N/D'}
- Peso: ${profile.pesoKg || 'N/D'} kg
- FTP vigente: ${profile.ftpVigente || 'N/D'} W
- FC máxima: ${profile.fcMax || 'N/D'} bpm · FC en reposo: ${profile.fcReposo || 'N/D'} bpm
- Nivel: ${profile.nivel || 'N/D'}

HISTORIAL DE FTP
${ftpText}

SESIONES RECIENTES (más reciente al final)
${historyText}

ENFOQUE DE ENTRENAMIENTO ELEGIDO: ${input.approach}
${scaffold.approachCfg.intensityNote}

HIDRATACIÓN
${hydrationText}

CALENDARIO A COMPLETAR (fecha, día de la semana, minutos disponibles, fase de periodización)
${weeksText}

${eventNote}

INSTRUCCIONES
1. Para cada fecha del calendario de arriba, diseña UN entrenamiento con estructura de intervalos en % de FTP (nunca en vatios fijos).
2. La suma de las duraciones de los intervalos (en segundos) de cada día debe ser igual a los minutos disponibles de esa fecha convertidos a segundos, con una tolerancia de ±2 minutos.
3. Respeta la fase de periodización de cada semana: "base" y "recovery" deben ser mayormente Z1-Z2 (50-75% FTP); "build" y "peak" deben incluir el trabajo duro correspondiente al enfoque elegido; "taper" debe ser corto y de baja fatiga con algún estímulo breve para mantener piernas rápidas.
4. Usa el historial de sesiones y de FTP como contexto de la condición física actual: si el ciclista viene de pocas sesiones o potencia normalizada baja respecto a su FTP, empieza más conservador que la progresión típica del enfoque elegido.
5. Ponle a cada entrenamiento un nombre corto y descriptivo (ej. "Umbral 2x15", "Fondo Z2", "VO2max 5x4").
6. No incluyas las fechas de test de FTP — esas se agregan aparte con un protocolo fijo, no las repitas en tu respuesta.
7. Para cada entrenamiento, recomienda "hydrationMl" (ml totales de agua para esa sesión) y "hydrationSachets" (cuántos sobres, en pasos de 0.5) según la duración y la intensidad del día. Nunca recomiendes más de 2 sobres por sesión. En sesiones cortas o muy suaves (menos de ~25 min, o todo Z1) puede ser 0 sobres, solo agua.

Responde ÚNICAMENTE con JSON válido, sin texto adicional antes ni después, sin comentarios, sin backticks de markdown, con exactamente esta forma:
{"workouts":[{"date":"YYYY-MM-DD","name":"string","intervals":[{"duration":segundos_numero,"targetFTPPercent":numero}],"hydrationMl":numero,"hydrationSachets":numero}]}`;
}

function callClaude_(prompt) {
  const apiKey = PropertiesService.getScriptProperties().getProperty(API_KEY_PROPERTY);
  if (!apiKey) {
    throw new Error(
      'Falta configurar la clave de API. Usa el menú "🚴 Plan de entrenamiento → ' +
        'Configurar clave de API de Claude".'
    );
  }

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      messages: [{ role: 'user', content: prompt }],
    }),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code !== 200) {
    throw new Error(`Error de la API de Claude (${code}): ${body}`);
  }

  const data = JSON.parse(body);
  const text = (data.content || []).map((b) => b.text || '').join('');

  if (data.stop_reason === 'max_tokens') {
    throw new Error(
      'La respuesta se cortó por ser demasiado larga. Prueba con menos semanas (evento más ' +
        'cercano o menos "semanas si no hay evento") o menos días de entrenamiento por semana.'
    );
  }

  return text;
}

function parseClaudePlan_(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('La respuesta de Claude no fue JSON válido. Intenta generar el plan de nuevo.');
  }
  if (!parsed.workouts || !Array.isArray(parsed.workouts)) {
    throw new Error('La respuesta de Claude no tenía la forma esperada.');
  }
  return parsed.workouts;
}

// ---------------------------------------------------------------------------
// Protocolo fijo de test de FTP (no depende del modelo, para que sea confiable).
// Rampa escalonada con escalones de 1 minuto: empieza en 45% FTP y sube 5 puntos
// cada minuto durante 20 escalones (hasta 140%), siguiendo el mismo esquema que
// un ramp test clásico (Zwift/TrainerRoad) pero expresado en %FTP en vez de
// vatios fijos. No hace falta completar los 20 escalones — el nuevo FTP se
// estima con el 75% de la potencia media sostenida durante el último escalón
// completo que aguantes (ver estimateFromRampTest en ftp.js de la app web).
// ---------------------------------------------------------------------------

function ftpRampTestIntervals_() {
  const intervals = [{ duration: 600, targetFTPPercent: 55 }]; // calentamiento progresivo, 10 min
  const startPercent = 45;
  const incrementPercent = 5;
  const totalSteps = 20; // 20 escalones x 1 min = 20 min de rampa
  for (let i = 0; i < totalSteps; i++) {
    intervals.push({ duration: 60, targetFTPPercent: startPercent + i * incrementPercent });
  }
  intervals.push({ duration: 600, targetFTPPercent: 50 }); // vuelta a la calma
  return intervals;
}

// Entrada opcional de "día de descanso / inicio del plan" cuando el ciclista
// elige no testear ni entrenar en su fecha de inicio — deja el día como muy
// suave y opcional, pero igual queda una fila en Calendario para esa fecha.
function restDayIntervals_() {
  return [{ duration: 900, targetFTPPercent: 50 }];
}

// Ajusta la suma de duraciones de los intervalos al tiempo disponible del día,
// por si Claude se desvía más de ±10% de los minutos pedidos.
function reconcileDuration_(intervals, targetMinutes) {
  const targetSec = targetMinutes * 60;
  const sum = intervals.reduce((s, i) => s + Number(i.duration || 0), 0);
  if (sum === 0) return intervals;
  const diffRatio = Math.abs(sum - targetSec) / targetSec;
  if (diffRatio <= 0.1) return intervals;
  const scale = targetSec / sum;
  return intervals.map((i) => ({ duration: Math.round(i.duration * scale), targetFTPPercent: i.targetFTPPercent }));
}

// ---------------------------------------------------------------------------
// Duración e hidratación por entrenamiento (columnas D y E de Calendario)
// ---------------------------------------------------------------------------

function computeTotalDurationMin_(intervals) {
  const totalSec = (intervals || []).reduce((s, i) => s + Number(i.duration || 0), 0);
  return Math.round(totalSec / 60);
}

function weightedAvgIntensity_(intervals) {
  const totalSec = (intervals || []).reduce((s, i) => s + Number(i.duration || 0), 0);
  if (!totalSec) return 0;
  const weighted = intervals.reduce((s, i) => s + Number(i.duration || 0) * Number(i.targetFTPPercent || 0), 0);
  return Math.round(weighted / totalSec);
}

// Estimación general de respaldo (regla de dedo, no un cálculo de tasa de
// sudoración personalizado) para las fechas que no pasan por Claude: el test
// de FTP y el día de descanso/inicio. Usa la misma referencia de ~700 ml/hora
// que se le da a Claude en el prompt, para que los números no queden dispares.
function fallbackHydration_(durationMin, avgIntensityPercent) {
  const intensityFactor = avgIntensityPercent >= 90 ? 1.3 : avgIntensityPercent >= 70 ? 1.1 : 0.9;
  const mlPerMinute = (700 / 60) * intensityFactor;
  let waterMl = Math.round((durationMin * mlPerMinute) / 25) * 25;
  waterMl = Math.max(200, Math.min(2000, waterMl));

  let sachets = 0;
  if (durationMin >= 90) sachets = 2;
  else if (durationMin >= 45) sachets = 1;
  else if (durationMin >= 25 && avgIntensityPercent >= 80) sachets = 0.5;

  return { waterMl: waterMl, sachets: sachets };
}

// Combina lo que devolvió Claude con el respaldo determinístico: si Claude no
// mandó un número válido, usa el respaldo. Siempre aplica un tope de seguridad
// (0-2 sobres, 200-2000 ml) sin importar de dónde vino el número.
function resolveHydration_(claudeHydration, durationMin, avgIntensityPercent) {
  const fallback = fallbackHydration_(durationMin, avgIntensityPercent);
  let waterMl = Number(claudeHydration && claudeHydration.waterMl);
  let sachets = Number(claudeHydration && claudeHydration.sachets);
  if (!waterMl || isNaN(waterMl)) waterMl = fallback.waterMl;
  if (isNaN(sachets)) sachets = fallback.sachets;

  waterMl = Math.max(200, Math.min(2000, Math.round(waterMl)));
  sachets = Math.max(0, Math.min(2, Math.round(sachets * 2) / 2)); // pasos de 0.5

  return { waterMl: waterMl, sachets: sachets };
}

function formatHydration_(hydration) {
  if (!hydration) return '';
  const sachetsText =
    hydration.sachets === 0 ? 'sin sobre' : hydration.sachets === 1 ? '1 sobre' : `${hydration.sachets} sobres`;
  return `${hydration.waterMl} ml agua + ${sachetsText} de hidratante`;
}

// ---------------------------------------------------------------------------
// Escritura en la pestaña Calendario (mismo criterio de upsert que workouts.js
// de la app: si ya existe una fila para esa fecha, se reemplaza; si no, se agrega).
// Columnas: A fecha · B nombre · C intervalos_json · D duracion_min · E hidratacion.
// ---------------------------------------------------------------------------

function upsertCalendarRow_(sheet, dateISO, name, intervals, hydration) {
  const values = sheet.getDataRange().getValues();
  let rowIndex = -1;
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][0]) === dateISO) {
      rowIndex = r + 1;
      break;
    }
  }
  const durationMin = computeTotalDurationMin_(intervals);
  const row = [dateISO, name, JSON.stringify(intervals), durationMin, formatHydration_(hydration)];
  const targetRow = rowIndex === -1 ? sheet.getLastRow() + 1 : rowIndex;
  sheet.getRange(targetRow, 1, 1, 5).setValues([row]);
  sheet.getRange(targetRow, 1).setNumberFormat('@'); // mantiene la fecha como texto plano
}

// ---------------------------------------------------------------------------
// Punto de entrada principal, llamado desde el wizard
// ---------------------------------------------------------------------------

function generateTrainingPlan(input) {
  if (!input || !input.days || !input.days.filter((d) => Number(d.durationMin) > 0).length) {
    throw new Error('Selecciona al menos un día de entrenamiento con duración válida.');
  }

  const profile = getCyclistProfile_();
  const history = getRecentHistory_(10);
  const ftpHistory = getFTPHistory_();
  const scaffold = buildScaffold_(input);

  const prompt = buildClaudePrompt_(profile, history, ftpHistory, scaffold, input);
  const raw = callClaude_(prompt);
  const workouts = parseClaudePlan_(raw);

  const byDate = {};
  workouts.forEach((w) => {
    byDate[w.date] = w;
  });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const calSheet = ss.getSheetByName('Calendario');
  if (!calSheet) throw new Error('No se encontró la pestaña "Calendario".');

  let written = 0;
  const missingDates = [];

  scaffold.slots.forEach((slot) => {
    const w = byDate[slot.date];
    if (!w) {
      missingDates.push(slot.date);
      return;
    }
    const intervals = reconcileDuration_(w.intervals || [], slot.durationMin);
    const avgIntensity = weightedAvgIntensity_(intervals);
    const hydration = resolveHydration_(
      { waterMl: w.hydrationMl, sachets: w.hydrationSachets },
      slot.durationMin,
      avgIntensity
    );
    upsertCalendarRow_(calSheet, slot.date, w.name || input.planName, intervals, hydration);
    written += 1;
  });

  scaffold.testDates.forEach((dateISO) => {
    const intervals = ftpRampTestIntervals_();
    const hydration = resolveHydration_(null, computeTotalDurationMin_(intervals), weightedAvgIntensity_(intervals));
    upsertCalendarRow_(
      calSheet,
      dateISO,
      'Test de FTP – rampa escalonada (escalones de 1 min, sube hasta que no puedas más)',
      intervals,
      hydration
    );
    written += 1;
  });

  if (scaffold.restDayEntry) {
    const intervals = restDayIntervals_();
    const hydration = resolveHydration_(null, computeTotalDurationMin_(intervals), weightedAvgIntensity_(intervals));
    upsertCalendarRow_(
      calSheet,
      scaffold.restDayEntry.date,
      'Inicio del plan — descanso (opcional: 15 min muy suaves, o descansa del todo)',
      intervals,
      hydration
    );
    written += 1;
  }

  return {
    weeksGenerated: scaffold.totalWeeks,
    workoutsWritten: written,
    ftpTestDates: scaffold.testDates.slice().sort(),
    missingDates: missingDates,
    truncated: scaffold.truncated,
    planName: input.planName,
  };
}
