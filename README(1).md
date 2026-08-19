# App de entrenamiento de ciclismo

Prototipo funcional que conecta potenciómetro, rodillo inteligente (FTMS) y
banda de FC vía Web Bluetooth, lee/guarda el calendario en Google Sheets,
sigue la progresión de FTP y grafica la sesión en vivo.

## Requisitos

- Chrome o Edge de escritorio (Web Bluetooth no funciona en Safari ni Firefox).
- Rodillo con soporte FTMS o Tacx FE-C sobre BLE (la mayoría de modelos 2018+).
- Potenciómetro y banda de FC con Bluetooth (perfiles Cycling Power / Heart Rate estándar).

## 1. Correr el proyecto localmente

Web Bluetooth exige un "contexto seguro": HTTPS, o `localhost`. Para desarrollo,
`localhost` es suficiente. Desde la carpeta del proyecto:

```bash
python3 -m http.server 8000
# o: npx serve .
```

Abre `http://localhost:8000` en Chrome o Edge.

## 2. Crear credenciales de Google Sheets

1. Ve a [Google Cloud Console](https://console.cloud.google.com/) y crea un proyecto.
2. En "APIs y servicios" → "Biblioteca", habilita **Google Sheets API**.
3. En "APIs y servicios" → "Pantalla de consentimiento OAuth", configúrala como
   "Externa" y agrégate a ti mismo como usuario de prueba.
4. En "Credenciales" → "Crear credenciales" → "ID de cliente de OAuth",
   tipo **Aplicación web**. En "Orígenes de JavaScript autorizados" agrega
   `http://localhost:8000` (o el puerto que uses).
5. Copia el Client ID generado y pégalo en `js/sheets.js`, en la constante `CLIENT_ID`.
6. Crea una hoja de cálculo en Google Sheets, cópiale el ID (está en la URL,
   entre `/d/` y `/edit`) y pégalo en `js/app.js`, en `SPREADSHEET_ID`.

## 3. Estructura de la hoja de cálculo

Crea tres pestañas:

**Calendario** (una fila por día con entrenamiento asignado — se llena sola
desde el editor de la app o desde "Create My Custom Plan", no hace falta escribirla
a mano):

| A (fecha)  | B (nombre)  | C (intervalos, JSON) | D (duracion_min) | E (hidratacion) |
|------------|-------------|------------------------|---------------------|----------------------|
| 2026-08-20 | Umbral 2x20 | `[{"duration":600,"targetPower":150},{"duration":1200,"targetFTPPercent":100},...]` | 65 | 825 ml agua + 1 sobre de hidratante |

`duration` en segundos. Cada intervalo trae `targetPower` (vatios fijos) **o**
`targetFTPPercent` (porcentaje del FTP vigente); la app resuelve el segundo
caso a vatios automáticamente al cargar el entrenamiento. Las columnas D y E se
calculan solas al guardar (desde la app o desde el generador de planes) — no hace
falta completarlas a mano.

**Historial** (se llena automáticamente al terminar cada sesión):

| fecha | entrenamiento | duración (s) | potencia media | potencia normalizada | FC media | cadencia media | TSS |
|-------|----------------|---------------|------------------|------------------------|-----------|------------------|-----|

**FTP** (crea solo los encabezados; la app agrega filas cuando registras un FTP):

| A (fecha)  | B (ftp, vatios) | C (motivo)        |
|------------|------------------|--------------------|
| 2026-08-01 | 245              | test 20min         |

## Qué resuelve este prototipo

- **Sensores**: conexión BLE a potenciómetro, banda de FC y rodillo, con
  **reconexión automática**: si un sensor se cae a mitad de sesión (rango,
  batería), la app reintenta solo, con backoff, y avisa en el estado.
  Al reconectar el rodillo, reaplica automáticamente la potencia objetivo
  del intervalo en curso.
- **Control ERG**: fija la potencia objetivo del rodillo por intervalo vía FTMS.
- **Calendario en Sheets**: un editor dentro de la propia app (sección
  "Editor de entrenamientos") para armar o modificar el entrenamiento de
  cualquier fecha con un formulario — sin tocar JSON a mano.
- **FTP y progresión**: pestaña `FTP` con historial de valores; puedes
  registrar uno manualmente (ej. tras un test de 20 min) y pedirle a la app
  que revise tus últimas sesiones y sugiera si conviene subirlo o bajarlo.
  Los entrenamientos pueden definirse en `%FTP` en vez de vatios fijos, así
  que al subir el FTP, las próximas sesiones se recalculan solas.
- **Sesión larga sin cortes**: el token de Google se renueva solo antes de
  vencer (los tokens de GIS duran ~1h), para que una sesión de 2+ horas no
  falle a mitad de camino guardando datos.
- **Gráfica en vivo**: curva de potencia y FC de los últimos 3 minutos,
  visible durante toda la sesión.
- **Hidratación por entrenamiento**: cada fila de Calendario trae cuántos ml de
  agua y cuántos sobres de hidratante tomar en esa sesión (columna E), visible
  también en la pantalla de la app antes de empezar. Detalle de cómo se calcula
  en `apps-script/README.md`.

## Generar un plan de entrenamiento con Claude

Además de la app web, `apps-script/` tiene un generador de planes que vive directamente
en el Google Sheet: un botón "Create My Custom Plan" que abre un asistente, junta tus
datos (perfil, historial, FTP), le pide a Claude que diseñe las semanas, y las escribe
solo en Calendario — incluyendo los tests de FTP programados según qué tan agresivo
elijas el plan. Instrucciones de instalación y cómo funciona por dentro en
`apps-script/README.md`.

## Limitaciones a tener presentes

- La renovación del token de Google (`ensureValidToken` en `sheets.js`) suele
  funcionar sin interacción si ya diste consentimiento en la pestaña, pero
  algunos navegadores con políticas estrictas de cookies de terceros pueden
  igual pedir confirmación. Para una app en producción conviene un backend
  con refresh token.
- La sugerencia de FTP (`suggestFTPAdjustment` en `ftp.js`) es una heurística
  simple basada en comparar potencia normalizada contra el FTP vigente, no
  un test real. Sirve como señal, no como reemplazo de un test de 20 min o
  un ramp test.
- El offset de cadencia en `bluetooth.js` asume el caso más común de un
  potenciómetro de biela simple; si tu sensor reporta campos adicionales
  (balance de pedaleo, datos de rueda), puede necesitar un ajuste — el
  comentario en el código explica dónde.
- La hidratación sugerida (columna E de Calendario) es una regla general de
  ml/hora según duración e intensidad, no un cálculo de tasa de sudoración
  personalizado ni una recomendación médica. Si tienes alguna condición que
  requiera cuidar el sodio o el potasio, consulta con un profesional antes de
  seguirla al pie de la letra.
