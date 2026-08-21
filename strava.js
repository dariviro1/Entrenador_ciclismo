// strava.js
// Conexión con la cuenta de Strava de cada persona (OAuth) y subida de los
// entrenamientos terminados como actividad, además de guardarse en Sheets.
//
// ADVERTENCIA DE SEGURIDAD: a diferencia de Google (sheets.js), que usa un flujo de
// OAuth 100% en el navegador sin secreto, el intercambio de "code" por token de Strava
// exige el CLIENT_SECRET de la app. Como este proyecto no tiene backend, ese secreto
// queda expuesto en el código que corre en el navegador de cada persona -- cualquiera
// que inspeccione el código fuente puede verlo. Es un riesgo aceptado a propósito para
// una app de uso personal/entre amigos de confianza; ver el README para el detalle y
// cómo migrar esto a un backend/proxy si la app se distribuye más ampliamente.

const CLIENT_ID = 'TU_STRAVA_CLIENT_ID';
const CLIENT_SECRET = 'TU_STRAVA_CLIENT_SECRET';
const AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';
const TOKEN_URL = 'https://www.strava.com/oauth/token';
const UPLOAD_URL = 'https://www.strava.com/api/v3/uploads';
const SCOPE = 'activity:write';
const STORAGE_KEY = 'strava_tokens';

function loadTokens() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch (err) {
    return null;
  }
}
function saveTokens(tokens) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
}

export function isConnected() {
  return !!loadTokens()?.refreshToken;
}
export function getAthleteName() {
  return loadTokens()?.athleteName ?? null;
}
export function disconnect() {
  localStorage.removeItem(STORAGE_KEY);
}

// Manda a la persona a strava.com a iniciar sesión y aprobar el acceso. Vuelve a esta
// misma URL (sin path adicional: Strava valida el dominio del redirect contra el que
// se configuró en la app, ver README) con ?code=... en la query string.
export function beginAuthorization() {
  const redirectUri = window.location.origin + window.location.pathname;
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('approval_prompt', 'auto');
  url.searchParams.set('scope', SCOPE);
  window.location.href = url.toString();
}

// Se llama al cargar la app, por si venimos de vuelta del redirect de Strava. Si no hay
// ?code=... en la URL, no hace nada (caso normal, la mayoría de las cargas de página).
export async function handleAuthorizationRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return false;

  // Limpia el ?code=... de la URL antes que nada -- así, si el intercambio falla y la
  // persona recarga, no se reintenta con un code ya usado (Strava los invalida al toque).
  const cleanUrl = window.location.origin + window.location.pathname;
  window.history.replaceState({}, document.title, cleanUrl);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Strava: no se pudo completar la conexión (${res.status})`);
  const data = await res.json();
  saveTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at * 1000, // Strava da segundos epoch; Date.now() usa ms
    athleteName: data.athlete ? `${data.athlete.firstname ?? ''} ${data.athlete.lastname ?? ''}`.trim() : null,
  });
  return true;
}

async function ensureValidToken() {
  const tokens = loadTokens();
  if (!tokens?.refreshToken) throw new Error('Strava no está conectado.');

  const margin = 2 * 60 * 1000;
  if (Date.now() < tokens.expiresAt - margin) return tokens.accessToken;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Strava: no se pudo renovar la conexión (${res.status})`);
  const data = await res.json();
  const updated = {
    ...tokens,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? tokens.refreshToken, // Strava a veces rota el refresh_token
    expiresAt: data.expires_at * 1000,
  };
  saveTokens(updated);
  return updated.accessToken;
}

// --- TCX: formato que acepta Strava con potencia/FC/cadencia por segundo, sin GPS
// (necesario para una sesión indoor). El tag Watts va en la extensión TPX estándar de
// Garmin que Strava reconoce para graficar potencia igual que con un pedalier real. ---

function buildTCX({ startedAt, powerSamples, hrSamples, cadenceSamples }) {
  const trackpoints = powerSamples
    .map((power, i) => {
      const t = new Date(startedAt.getTime() + (i + 1) * 1000).toISOString();
      const hr = hrSamples[i] || 0;
      const cadence = cadenceSamples[i] || 0;
      const hrTag = hr > 0 ? `<HeartRateBpm><Value>${hr}</Value></HeartRateBpm>` : '';
      // Cadence en TCX es un byte (0-254); si el sensor da un pico ruidoso, se recorta.
      const cadenceTag = cadence > 0 ? `<Cadence>${Math.min(254, Math.round(cadence))}</Cadence>` : '';
      const watts = Math.max(0, Math.round(power));
      return `<Trackpoint><Time>${t}</Time>${hrTag}${cadenceTag}<Extensions><TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><Watts>${watts}</Watts></TPX></Extensions></Trackpoint>`;
    })
    .join('');

  const startIso = startedAt.toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>${startIso}</Id>
      <Lap StartTime="${startIso}">
        <TotalTimeSeconds>${powerSamples.length}</TotalTimeSeconds>
        <DistanceMeters>0</DistanceMeters>
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>${trackpoints}</Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;
}

// La subida en Strava es asíncrona: /uploads devuelve un upload_id de inmediato y hay
// que consultarlo hasta que termine de procesar (o falle) para saber si la actividad
// realmente quedó creada.
async function pollUploadStatus(uploadId, accessToken, attempt = 0) {
  const maxAttempts = 15;
  const res = await fetch(`${UPLOAD_URL}/${uploadId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Strava: no se pudo confirmar la subida (${res.status})`);
  const status = await res.json();
  if (status.error) throw new Error(`Strava rechazó la actividad: ${status.error}`);
  if (status.activity_id) return status;
  if (attempt >= maxAttempts) {
    throw new Error('Strava: la subida sigue procesándose, revisa la actividad en un rato.');
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return pollUploadStatus(uploadId, accessToken, attempt + 1);
}

// "Workout" en el enum de workout_type de Strava para actividades de tipo Ride/VirtualRide
// (10=Default, 11=Race, 12=Long Ride, 13=Workout). No es un valor documentado formalmente
// por Strava, pero sí ampliamente verificado por clientes de la API (ej. stravalib).
const RIDE_WORKOUT_TYPE = 13;

// El endpoint de subida no acepta workout_type -- hay que setearlo aparte, ya con el
// activity_id, actualizando la actividad recién creada.
async function setWorkoutType(activityId, accessToken) {
  const res = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workout_type: RIDE_WORKOUT_TYPE }),
  });
  if (!res.ok) throw new Error(`Strava: no se pudo etiquetar la actividad como "Workout" (${res.status})`);
}

// Sube la sesión terminada como Ride indoor (sin GPS). `trainer: true` es el campo que
// Strava documenta específicamente para este caso -- a diferencia de `activity_type`
// (que la propia documentación de Strava dice que "puede ser sobreescrito por el tipo
// detectado en el archivo"), `trainer` no depende de inferencia y es lo que usan apps
// como Zwift/TrainerRoad para que la actividad quede clasificada como Virtual Ride.
export async function uploadActivity({ name, startedAt, powerSamples, hrSamples, cadenceSamples }) {
  if (!powerSamples.length) throw new Error('Strava: no hay datos de la sesión para subir.');
  const accessToken = await ensureValidToken();
  const tcx = buildTCX({ startedAt, powerSamples, hrSamples, cadenceSamples });

  const form = new FormData();
  form.append('file', new Blob([tcx], { type: 'application/xml' }), 'session.tcx');
  form.append('data_type', 'tcx');
  form.append('name', name);
  form.append('activity_type', 'virtualride');
  form.append('trainer', 'true');

  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` }, // sin Content-Type: fetch arma el boundary del multipart solo
    body: form,
  });
  if (!res.ok) throw new Error(`Strava: falló la subida (${res.status})`);
  const upload = await res.json();
  const result = await pollUploadStatus(upload.id, accessToken);
  await setWorkoutType(result.activity_id, accessToken);
  return result;
}
