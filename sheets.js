// sheets.js
// Capa base de acceso a Google Sheets API v4 usando Google Identity Services (GIS).
// Antes de usar: sigue las instrucciones del README para crear tus credenciales
// y reemplaza CLIENT_ID más abajo.

const CLIENT_ID = 'TU_CLIENT_ID.apps.googleusercontent.com'; // reemplaza con el tuyo
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;

export function initGoogleClient() {
  if (tokenClient) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: () => {}, // se sobreescribe en signIn()
  });
}

export function signIn() {
  return new Promise((resolve, reject) => {
    tokenClient.callback = (response) => {
      if (response.error) return reject(response);
      accessToken = response.access_token;
      tokenExpiresAt = Date.now() + (response.expires_in ?? 3600) * 1000;
      resolve(accessToken);
    };
    tokenClient.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
  });
}

// Renueva el token si está por vencer (los tokens de GIS duran ~1h, y una sesión de
// entrenamiento largo puede superarlo). GIS normalmente puede renovarlo sin ventana
// emergente si el usuario ya dio consentimiento en esta pestaña, pero eso no está
// garantizado en todos los navegadores/políticas de cookies de terceros. Para una app
// en producción más robusta, considera un flujo con refresh token vía backend.
async function ensureValidToken() {
  const margin = 2 * 60 * 1000;
  if (!accessToken || Date.now() > tokenExpiresAt - margin) {
    await signIn();
  }
}

async function sheetsRequest(path, options = {}) {
  await ensureValidToken();
  const res = await fetch(`${SHEETS_API}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Sheets API error: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// --- Helpers genéricos, reutilizados por workouts.js, ftp.js e history.js ---

export async function getSheetValues(spreadsheetId, range) {
  const data = await sheetsRequest(`${spreadsheetId}/values/${range}`);
  return data.values || [];
}

export async function appendRow(spreadsheetId, sheetName, row) {
  await sheetsRequest(`${spreadsheetId}/values/${sheetName}!A1:append?valueInputOption=USER_ENTERED`, {
    method: 'POST',
    body: JSON.stringify({ values: [row] }),
  });
}

export async function updateRow(spreadsheetId, sheetName, rowNumber, row) {
  const lastCol = String.fromCharCode('A'.charCodeAt(0) + row.length - 1);
  const range = `${sheetName}!A${rowNumber}:${lastCol}${rowNumber}`;
  await sheetsRequest(`${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ values: [row] }),
  });
}
