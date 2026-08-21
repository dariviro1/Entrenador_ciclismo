// profilechart.js
// Gráficos de perfil del entrenamiento (completo y "zoom" de próximos intervalos),
// con línea de referencia de FTP y línea de playhead (posición actual del ciclista),
// usando Chart.js (cargado por CDN en index.html).

const POWER_COLOR = '#F2A93B';
const POWER_FILL = 'rgba(242, 169, 59, 0.35)';
const ACTUAL_POWER_COLOR = '#EDEFF3';
const HR_COLOR = '#E2574C';
const FTP_COLOR = '#4FB8C4';
const PLAYHEAD_COLOR = '#F2E63B';
const HYDRATION_COLOR = '#63C7FF';
const HYDRATION_MARKER_GAP = 16; // separación (px) entre el eje y la gota, reservada vía layout.padding.bottom

function formatMMSS(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

const ftpLinePlugin = {
  id: 'ftpLine',
  afterDraw(chart) {
    const ftp = chart.$ftp;
    if (!ftp) return;
    const { ctx, chartArea, scales } = chart;
    const y = scales.y.getPixelForValue(ftp);
    if (y < chartArea.top || y > chartArea.bottom) return;
    ctx.save();
    ctx.strokeStyle = FTP_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = FTP_COLOR;
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`FTP ${ftp}`, chartArea.right - 4, y - 2);
    ctx.restore();
  },
};

const playheadPlugin = {
  id: 'playhead',
  afterDraw(chart) {
    const x = chart.$playheadX;
    if (x == null) return;
    const { ctx, chartArea, scales } = chart;
    const px = scales.x.getPixelForValue(x);
    if (px < chartArea.left || px > chartArea.right) return;
    ctx.save();
    ctx.strokeStyle = PLAYHEAD_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, chartArea.top);
    ctx.lineTo(px, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

// Líneas verticales que marcan cuándo tomar agua durante el entrenamiento, repartidas
// a lo largo de la duración total según el volumen de hidratación sugerido (más ml,
// más recordatorios) -- ver computeHydrationReminders() en app.js.
const hydrationLinesPlugin = {
  id: 'hydrationLines',
  afterDraw(chart) {
    const times = chart.$hydrationReminders;
    if (!times || !times.length) return;
    const { ctx, chartArea, scales } = chart;
    ctx.save();
    ctx.strokeStyle = HYDRATION_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.fillStyle = HYDRATION_COLOR;
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const t of times) {
      const x = scales.x.getPixelForValue(t);
      if (x < chartArea.left || x > chartArea.right) continue;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      // La gota va debajo del área graficada (en el margen reservado con
      // layout.padding.bottom), no encima de la curva.
      ctx.fillText('💧', x, chartArea.bottom + 2);
    }
    ctx.restore();
  },
};

Chart.register(ftpLinePlugin, playheadPlugin, hydrationLinesPlugin);

export function createIntervalChart(canvasId) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          // 0: objetivo de potencia del plan (bloques)
          label: 'Objetivo (W)',
          data: [],
          borderColor: POWER_COLOR,
          backgroundColor: POWER_FILL,
          fill: true,
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: 'y',
        },
        {
          // 1: potencia real entregada, en vivo
          label: 'Potencia real (W)',
          data: [],
          borderColor: ACTUAL_POWER_COLOR,
          backgroundColor: 'transparent',
          fill: false,
          pointRadius: 0,
          borderWidth: 1.5,
          tension: 0.15,
          yAxisID: 'y',
        },
        {
          // 2: FC real, en vivo
          label: 'FC real (bpm)',
          data: [],
          borderColor: HR_COLOR,
          backgroundColor: 'transparent',
          fill: false,
          pointRadius: 0,
          borderWidth: 1.5,
          tension: 0.15,
          yAxisID: 'y1',
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      interaction: { intersect: false },
      // Margen reservado debajo del área graficada para que las gotas de hidratación
      // (hydrationLinesPlugin) queden claramente fuera de la curva, no superpuestas.
      layout: { padding: { bottom: HYDRATION_MARKER_GAP } },
      // La leyenda vive como HTML debajo de la gráfica (una fila por dataset, ver
      // .chart-legend en index.html) -- más legible que la fila horizontal de Chart.js.
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            // Por defecto el título del tooltip muestra el x crudo (segundos desde el
            // inicio del entrenamiento) -- lo mostramos como m:ss, mucho más legible.
            title: (items) => (items.length ? formatMMSS(items[0].parsed.x) : ''),
          },
        },
      },
      scales: {
        x: { type: 'linear', display: false },
        y: {
          beginAtZero: true,
          ticks: { color: '#7C8698' },
          grid: { color: '#2A3244' },
          title: { display: true, text: 'Potencia (W)', color: '#7C8698', font: { size: 10 } },
        },
        y1: {
          beginAtZero: true,
          position: 'right',
          ticks: { color: '#7C8698' },
          grid: { drawOnChartArea: false },
          title: { display: true, text: 'FC (bpm)', color: '#7C8698', font: { size: 10 } },
        },
      },
    },
  });
  chart.$ftp = null;
  chart.$playheadX = null;
  chart.$hydrationReminders = [];
  return chart;
}

// Cada intervalo aporta dos puntos (inicio y fin) al mismo target power, y el
// siguiente intervalo arranca en ese mismo instante x con su propio target:
// el salto vertical entre ambos puntos con igual x es lo que dibuja el "bloque".
function intervalsToPoints(intervals) {
  const points = [];
  let t = 0;
  for (const interval of intervals) {
    points.push({ x: t, y: interval.targetPower });
    t += interval.duration;
    points.push({ x: t, y: interval.targetPower });
  }
  return points;
}

// El eje Y se autoescala solo con los valores del entrenamiento; si el FTP queda por
// encima de ese máximo (entrenamientos suaves, todos los targets bajos), su línea cae
// fuera del área visible y el plugin la omite. Forzamos el techo del eje a que siempre
// incluya el FTP, con un margen para que la línea y su etiqueta no queden pegadas al borde.
function computeYAxisMax(intervals, ftp) {
  const maxTarget = intervals.reduce((max, i) => Math.max(max, i.targetPower), 0);
  const ceiling = ftp ? Math.max(maxTarget, ftp) : maxTarget;
  return ceiling > 0 ? ceiling * 1.15 : undefined;
}

export function renderProfile(chart, intervals, ftp, hydrationReminders) {
  chart.data.datasets[0].data = intervalsToPoints(intervals);
  chart.$ftp = ftp || null;
  chart.$hydrationReminders = hydrationReminders || [];
  chart.options.scales.y.suggestedMax = computeYAxisMax(intervals, ftp);
  chart.options.scales.x.min = undefined;
  chart.options.scales.x.max = undefined;
  chart.update('none');
}

const ZOOM_WINDOW_BACK = 60; // segundos hacia atrás
const ZOOM_WINDOW_FORWARD = 300; // segundos hacia adelante

export function renderZoom(chart, intervals, ftp, elapsedSec, hydrationReminders) {
  const totalDuration = intervals.reduce((sum, i) => sum + i.duration, 0);
  let min = elapsedSec - ZOOM_WINDOW_BACK;
  let max = elapsedSec + ZOOM_WINDOW_FORWARD;
  if (min < 0) {
    max -= min;
    min = 0;
  }
  if (max > totalDuration) {
    min -= max - totalDuration;
    max = totalDuration;
  }
  min = Math.max(0, min);

  chart.data.datasets[0].data = intervalsToPoints(intervals);
  chart.$ftp = ftp || null;
  chart.$hydrationReminders = hydrationReminders || [];
  chart.options.scales.y.suggestedMax = computeYAxisMax(intervals, ftp);
  chart.options.scales.x.min = min;
  chart.options.scales.x.max = max;
  chart.update('none');
}

export function setPlayhead(chart, elapsedSec) {
  chart.$playheadX = elapsedSec;
  chart.update('none');
}

// powerSamples/hrSamples: arrays con una muestra por segundo transcurrido de sesión
// (session.powerSamples/hrSamples en app.js) -- el índice i corresponde al segundo i+1,
// igual convención que usa pushSample() en livechart.js.
function samplesToPoints(samples) {
  return samples.map((y, i) => ({ x: i + 1, y }));
}

export function renderActualTrace(chart, powerSamples, hrSamples) {
  chart.data.datasets[1].data = samplesToPoints(powerSamples);
  chart.data.datasets[2].data = samplesToPoints(hrSamples);
  chart.update('none');
}
