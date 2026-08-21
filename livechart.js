// livechart.js
// Gráfica en vivo de potencia y FC durante la sesión, usando Chart.js (cargado por CDN en index.html).

let chart = null;
// app.js llama a pushSample() cada 3 segundos (no cada 1) para que la línea no se vea tan
// "nerviosa" -- 60 puntos x 3s = 180s (3 min) visibles, igual que antes.
const WINDOW = 60;

function formatMMSS(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function initChart(canvasId) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Potencia (W)',
          data: [],
          borderColor: '#F2A93B',
          backgroundColor: 'transparent',
          yAxisID: 'y',
          tension: 0.2,
          pointRadius: 0,
          borderWidth: 1.5,
        },
        {
          label: 'FC (bpm)',
          data: [],
          borderColor: '#E2574C',
          backgroundColor: 'transparent',
          yAxisID: 'y1',
          tension: 0.2,
          pointRadius: 0,
          borderWidth: 1.5,
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: { display: false },
        y: {
          beginAtZero: true,
          position: 'left',
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
      // La leyenda vive como HTML debajo de la gráfica (ver .chart-legend en index.html).
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            // El título por defecto muestra el segundo crudo (el label de cada punto) --
            // lo mostramos como m:ss, igual que en los gráficos de perfil.
            title: (items) => (items.length ? formatMMSS(Number(items[0].label)) : ''),
          },
        },
      },
    },
  });
  // chart.$ftp es leído por el plugin "ftpLine" registrado globalmente en profilechart.js
  // (Chart.register() lo aplica a toda instancia de Chart.js, incluida esta).
  chart.$ftp = null;
}

// Techo de potencia hasta la Zona 6 (Anaeróbica, ~150% FTP, modelo Coggan) para que un
// pico real de potencia no se corte contra el borde del eje -- mismo criterio que
// profilechart.js. Techo de FC = FC máxima + margen, desde la pestaña "Ciclista".
const POWER_ZONE_6_CEILING_RATIO = 1.5;
const HR_MAX_HEADROOM_RATIO = 1.05;

// Dibuja (o quita) la línea de referencia de FTP en la gráfica en vivo, igual que en los
// gráficos de perfil -- y asegura que el eje de potencia siempre la incluya en su rango.
export function setFTP(ftp) {
  if (!chart) return;
  chart.$ftp = ftp || null;
  chart.options.scales.y.suggestedMax = ftp ? ftp * POWER_ZONE_6_CEILING_RATIO * 1.15 : undefined;
  chart.update('none');
}

// Techo del eje de FC según la FC máxima real del ciclista (pestaña "Ciclista"), para que
// una sesión que llegue a esfuerzo máximo no quede con la línea pegada al borde.
export function setHrMax(hrMax) {
  if (!chart) return;
  chart.options.scales.y1.suggestedMax = hrMax ? hrMax * HR_MAX_HEADROOM_RATIO : undefined;
  chart.update('none');
}

export function pushSample(second, power, hr) {
  if (!chart) return;
  chart.data.labels.push(second);
  chart.data.datasets[0].data.push(power);
  chart.data.datasets[1].data.push(hr);
  if (chart.data.labels.length > WINDOW) {
    chart.data.labels.shift();
    chart.data.datasets[0].data.shift();
    chart.data.datasets[1].data.shift();
  }
  chart.update('none');
}

export function resetChart() {
  if (!chart) return;
  chart.data.labels = [];
  chart.data.datasets[0].data = [];
  chart.data.datasets[1].data = [];
  chart.update('none');
}

// Chart.js no siempre recalcula el tamaño solo al des-ocultar su contenedor
// (estaba en display:none al medir por última vez) -- hay que forzarlo.
export function resizeChart() {
  if (chart) chart.resize();
}
