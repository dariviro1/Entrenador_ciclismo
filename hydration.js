// hydration.js
// Estimación general de hidratación por entrenamiento: ml de agua y sobres de
// hidratante, a partir de la duración y la intensidad media del entrenamiento.
// Es una regla general (no un cálculo personalizado de tasa de sudoración) —
// referencia rápida, no reemplaza ajustar según tu propia experiencia y el clima.
// Usa la misma fórmula que el respaldo determinístico del generador de planes
// (apps-script/Code.gs, función fallbackHydration_), para que los números no
// queden dispares entre un entrenamiento creado a mano y uno generado con Claude.
//
// Composición del sobre (20.7 g): 13.5 g dextrosa, ~1703 mg sodio elemental
// (de citrato de sodio + cloruro de sodio), ~787 mg potasio elemental (de
// cloruro de potasio) — ver el detalle del cálculo en Code.gs.

export function weightedAvgIntensity(intervals) {
  const totalSec = (intervals || []).reduce((s, i) => s + Number(i.duration || 0), 0);
  if (!totalSec) return 0;
  const weighted = intervals.reduce((s, i) => s + Number(i.duration || 0) * Number(i.targetFTPPercent || 0), 0);
  return Math.round(weighted / totalSec);
}

export function computeHydration(durationMin, avgIntensityPercent) {
  const intensityFactor = avgIntensityPercent >= 90 ? 1.3 : avgIntensityPercent >= 70 ? 1.1 : 0.9;
  const mlPerMinute = (700 / 60) * intensityFactor;
  let waterMl = Math.round((durationMin * mlPerMinute) / 25) * 25;
  waterMl = Math.max(200, Math.min(2000, waterMl));

  let sachets = 0;
  if (durationMin >= 90) sachets = 2;
  else if (durationMin >= 45) sachets = 1;
  else if (durationMin >= 25 && avgIntensityPercent >= 80) sachets = 0.5;

  return { waterMl, sachets };
}

export function formatHydration(hydration) {
  if (!hydration) return '';
  const sachetsText =
    hydration.sachets === 0 ? 'sin sobre' : hydration.sachets === 1 ? '1 sobre' : `${hydration.sachets} sobres`;
  return `${hydration.waterMl} ml agua + ${sachetsText} de hidratante`;
}
