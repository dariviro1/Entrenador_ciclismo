# Generador de planes de entrenamiento (Google Sheets + Claude)

Agrega un botón directamente en tu Google Sheet — "Create My Custom Plan" — que arma
un wizard, junta tus datos (perfil, historial, FTP), le pide a Claude que diseñe los
entrenamientos, y los escribe en la pestaña Calendario. Es independiente de la app web:
vive dentro del propio Sheet como un Apps Script.

## Instalar

1. Abre tu Google Sheet (el que ya tiene las pestañas Ciclista/Calendario/Historial/FTP).
2. Menú **Extensiones → Apps Script**.
3. Borra el contenido de `Code.gs` que viene por defecto y pega el `Code.gs` de esta carpeta.
4. Click en **+** junto a "Archivos" → **HTML** → nómbralo exactamente `PlanWizard`
   (sin extensión, Apps Script la agrega solo) → pega el contenido de `PlanWizard.html`.
5. Guarda (ícono de disco o Ctrl/Cmd+S).
6. Vuelve a tu Google Sheet y recarga la página. Debería aparecer un nuevo menú
   **"🚴 Plan de entrenamiento"** junto a Archivo/Editar/etc. (puede tardar unos segundos
   en aparecer la primera vez).

## Configurar tu clave de API

1. Crea una clave en [console.anthropic.com](https://console.anthropic.com/settings/keys)
   (necesitas una cuenta con crédito/facturación activa — es un servicio de pago, aparte
   de cualquier plan de Claude.ai que ya tengas).
2. En el Sheet: **🚴 Plan de entrenamiento → Configurar clave de API de Claude**, pégala.
3. Se guarda en las Propiedades del Script (`PropertiesService`), no en el código — no
   queda visible para nadie que solo vea el Sheet o el código del Apps Script.
4. La primera vez que el script llame a `UrlFetchApp`, Google te pedirá autorizar el
   proyecto (acceso a este Sheet y a servicios externos). Es normal, acéptalo.

## Usar el asistente

**🚴 Plan de entrenamiento → Create My Custom Plan** y sigue los 5 pasos:

1. **Fecha de inicio**, y qué quieres que sea ese día — siempre queda incluido en el
   plan, con tres opciones:
   - **Test de FTP**: siempre una rampa escalonada de 20 minutos (ver protocolo abajo).
   - **Usar mi FTP vigente, sin entrenar ese día**: el día queda como descanso/arranque
     (una fila ligera en Calendario), y tu primer entrenamiento real es el siguiente
     día que elijas en el paso 4.
   - **Que sea mi primer entrenamiento**: usa tu FTP vigente y arranca directo con una
     sesión normal ese mismo día.
2. Evento (o cuántas semanas planificar si no tienes uno).
3. Training Approach.
4. Qué días entrenas y por cuánto tiempo.
5. Nombre del plan.

Al confirmar, Claude genera los entrenamientos y el script los escribe en Calendario —
verás un resumen con cuántos se crearon y las fechas de test de FTP programadas.

## Cómo arma el plan (para que no sea una caja negra)

El script separa lo determinístico de lo que le pide a Claude:

- **Determinístico (código, no el modelo):** qué fechas caen según los días que
  elegiste, cuántas semanas dura el plan, qué fase de periodización le toca a cada
  semana (base / build / recovery / peak / taper), tu fecha de inicio (siempre incluida,
  según lo que elegiste para ese día), y qué fechas se convierten en test de FTP — con
  un protocolo fijo, no generado por IA, para que sea confiable.
- **A cargo de Claude:** diseñar el entrenamiento específico de cada fecha (nombre,
  intervalos en %FTP) respetando la fase de esa semana, el tiempo disponible ese día,
  y tu historial reciente — usando tu perfil (FTP, peso, FC) y tus últimas sesiones
  como contexto de tu condición actual.

**El test de FTP siempre es una rampa escalonada con escalones de 1 minuto**
(tanto si lo eliges en tu fecha de inicio como en los tests periódicos durante el
plan): calentamiento de 10 min, luego escalones de 1 minuto que empiezan en 45% FTP
y suben 5 puntos cada uno (46%, 50%, 55%... hasta 140%), y vuelta a la calma. No hace
falta completar los 20 escalones — sube hasta que ya no puedas sostener el objetivo,
tal como funciona un ramp test real (Zwift, TrainerRoad). Tu nuevo FTP se estima con
el 75% de la potencia media del último escalón que termines completo
(`estimateFromRampTest` en `ftp.js` de la app web).

**Cadencia de test de FTP periódico por Training Approach** (asunción de diseño propia,
ajustable en `APPROACHES` dentro de `Code.gs`):

| Approach | Cada cuántas semanas testear FTP | Semana de descarga cada... |
|---|---|---|
| Conservative | 8 | 3 semanas |
| Moderate | 6 | 4 semanas |
| Balanced (recomendado) | 6 | 4 semanas |
| Demanding | 4 | 3 semanas |
| Aggressive | 3 | 3 semanas |

Los tests se agregan como una fila más en Calendario ("Test de FTP – rampa
escalonada, escalones de 1 min"); cuando lo completes en la app, anota la potencia
media del último escalón que lograste terminar entero y guárdala con el botón
"Guardar" de la sección FTP — el nuevo FTP es 75% de esa potencia
(`estimateFromRampTest` en `ftp.js` ya hace esa cuenta). Eso alimenta la pestaña
FTP, que a su vez alimenta el próximo plan que generes.

## Duración e hidratación por entrenamiento

Cada fila de Calendario ahora tiene dos columnas más:

- **D (duracion_min):** la duración total del entrenamiento, calculada solo sumando
  los intervalos — no depende de Claude, así que siempre es exacta.
- **E (hidratacion):** cuántos ml de agua y cuántos sobres de hidratante tomar en esa
  sesión. Para los días que diseña Claude, se lo pide como parte del mismo plan
  (`hydrationMl` / `hydrationSachets` en la respuesta JSON), dándole la composición
  real del sobre como contexto:

  | Por sobre (20.7 g) | Cantidad |
  |---|---|
  | Carbohidratos (dextrosa) | 13.5 g |
  | Sodio elemental (citrato de sodio + cloruro de sodio) | ~1703 mg |
  | Potasio elemental (cloruro de potasio) | ~787 mg |

  (Los mg de sodio/potasio elemental no vienen en la etiqueta — se calculan a partir
  de la masa molar de cada sal; el detalle está comentado en `Code.gs` junto a la
  constante `SACHET`.) Claude nunca recomienda más de 2 sobres por sesión.

  Para el test de FTP y el día de descanso/inicio (que no pasan por Claude), se usa
  una fórmula de respaldo determinística con la misma referencia (~700 ml/hora, más
  o menos según intensidad) — así los números no quedan dispares entre lo que genera
  la IA y lo que arma el código directamente. Es una regla general, no un cálculo de
  tasa de sudoración personalizado — ajústala según tu propia experiencia y clima, y
  si tienes alguna condición que requiera cuidar el sodio o el potasio, consulta con
  un profesional antes de seguirla al pie de la letra.

## Cómo se adapta según lo que sí/no completaste

Este generador no reajusta un plan ya escrito de forma automática en tiempo real — lo
que hace es que **cada vez que vuelves a correr el asistente**, junta tu historial y tu
FTP más reciente (incluida la heurística `suggestFTPAdjustment` que ya usa la app) y se
lo pasa a Claude como contexto, así que un plan nuevo generado después de unas semanas
de baja adherencia o potencia normalizada floja empieza más conservador que uno generado
justo después de un bloque bien cumplido. La forma de usarlo es: generas un bloque (4-8
semanas típico), lo entrenas, y cuando se acerque el final vuelves a correr el asistente
para el siguiente bloque — eso es lo que lo hace "adaptativo" en la práctica.

## Límites a tener presentes

- **Planes muy largos se generan en bloques.** Si tu evento está a más de 16 semanas,
  el asistente genera igual las primeras 16 (fase base/build, sin taper) y te avisa que
  hay que volver a correrlo más adelante para la fase de pico. Es un límite práctico de
  tamaño de respuesta de la API, no una limitación real de periodización.
- **La estructura de días/duración es fija por semana.** Si eliges lunes/miércoles/viernes
  a 60 min, el plan completo repite esos mismos slots cada semana — lo que cambia semana
  a semana es la intensidad y el tipo de sesión, no el horario.
- **El costo de la API lo cubres tú directamente** con tu propia clave — revisa el
  precio vigente por token en la consola de Anthropic antes de generar planes muy largos
  o de forma muy seguida.
- Como con cualquier IA, revisa el plan generado antes de una semana muy dura — si algo
  se ve desproporcionado para tu nivel, ajústalo a mano en Calendario o desde el editor
  de la app.
- Si eliges "usar mi FTP vigente, sin entrenar" para tu fecha de inicio, esa fila en
  Calendario queda como un día muy suave y opcional (15 min o nada) — no la confundas
  con un test: no genera ningún dato nuevo de FTP.
