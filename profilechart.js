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

// El eje Y se autoescala solo con los valores planeados del entrenamiento; si el FTP o la
// potencia real entregada (que puede superar bastante el plan) quedan por encima de ese
// máximo, la línea cae fuera del área visible. Forzamos el techo a cubrir siempre, como
// mínimo, hasta el techo de la Zona 6 (Anaeróbica, ~150% FTP en el modelo Coggan) -- así
// un pico real por encima del target planeado no se corta, sin depender de que el
// entrenamiento cargado ya incluya un intervalo así de exigente.
const POWER_ZONE_6_CEILING_RATIO = 1.5;

function computeYAxisMax(intervals, ftp) {
  const maxTarget = intervals.reduce((max, i) => Math.max(max, i.targetPower), 0);
  const zoneCeiling = ftp ? ftp * POWER_ZONE_6_CEILING_RATIO : 0;
  const ceiling = Math.max(maxTarget, ftp || 0, zoneCeiling);
  return ceiling > 0 ? ceiling * 1.15 : undefined;
}

// FC máxima (pestaña "Ciclista") + margen: cubre incluso una sesión donde el ciclista
// llega a su FC máxima real, sin que la línea quede pegada al borde superior.
const HR_MAX_HEADROOM_RATIO = 1.05;

function computeHrAxisMax(hrMax) {
  return hrMax ? hrMax * HR_MAX_HEADROOM_RATIO : undefined;
}

export function renderProfile(chart, intervals, ftp, hydrationReminders, hrMax) {
  chart.data.datasets[0].data = intervalsToPoints(intervals);
  chart.$ftp = ftp || null;
  chart.$hydrationReminders = hydrationReminders || [];
  chart.options.scales.y.suggestedMax = computeYAxisMax(intervals, ftp);
  chart.options.scales.y1.suggestedMax = computeHrAxisMax(hrMax);
  chart.options.scales.x.min = undefined;
  chart.options.scales.x.max = undefined;
  chart.update('none');
}

const ZOOM_WINDOW_BACK = 60; // segundos hacia atrás
const ZOOM_WINDOW_FORWARD = 300; // segundos hacia adelante

export function renderZoom(chart, intervals, ftp, elapsedSec, hydrationReminders, hrMax) {
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
  chart.options.scales.y1.suggestedMax = computeHrAxisMax(hrMax);
  chart.options.scales.x.min = min;
  chart.options.scales.x.max = max;
  chart.update('none');
}

export function setPlayhead(chart, elapsedSec) {
  chart.$playheadX = elapsedSec;
  chart.update('none');
}

// powerSamples/hrSamples/times son arrays paralelos: times[i] es el segundo de sesión al
// que corresponde powerSamples[i]/hrSamples[i]. app.js las arma ya promediadas cada
// pocos segundos (no una muestra por segundo) para que la línea no se vea tan "nerviosa".
function toPoints(samples, times) {
  return samples.map((y, i) => ({ x: times[i], y }));
}

export function renderActualTrace(chart, powerSamples, hrSamples, times) {
  chart.data.datasets[1].data = toPoints(powerSamples, times);
  chart.data.datasets[2].data = toPoints(hrSamples, times);
  chart.update('none');
}
