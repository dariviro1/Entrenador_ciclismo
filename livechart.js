// livechart.js
// Gráfica en vivo de potencia y FC durante la sesión, usando Chart.js (cargado por CDN en index.html).

let chart = null;
const WINDOW = 180; // segundos visibles en la ventana deslizante de la gráfica

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
        y: { position: 'left', ticks: { color: '#7C8698' }, grid: { color: '#2A3244' } },
        y1: { position: 'right', ticks: { color: '#7C8698' }, grid: { drawOnChartArea: false } },
      },
      plugins: { legend: { labels: { color: '#C7CDD9', boxWidth: 12 } } },
    },
  });
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
