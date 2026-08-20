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

Chart.register(ftpLinePlugin, playheadPlugin);

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
      plugins: { legend: { labels: { color: '#C7CDD9', boxWidth: 12, font: { size: 10 } } } },
      scales: {
        x: { type: 'linear', display: false },
        y: { beginAtZero: true, ticks: { color: '#7C8698' }, grid: { color: '#2A3244' } },
        y1: { beginAtZero: true, position: 'right', ticks: { color: '#7C8698' }, grid: { drawOnChartArea: false } },
      },
    },
  });
  chart.$ftp = null;
  chart.$playheadX = null;
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

export function renderProfile(chart, intervals, ftp) {
  chart.data.datasets[0].data = intervalsToPoints(intervals);
  chart.$ftp = ftp || null;
  chart.options.scales.x.min = undefined;
  chart.options.scales.x.max = undefined;
  chart.update('none');
}

const ZOOM_WINDOW_BACK = 60; // segundos hacia atrás
const ZOOM_WINDOW_FORWARD = 300; // segundos hacia adelante

export function renderZoom(chart, intervals, ftp, elapsedSec) {
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
