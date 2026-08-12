# Karl Engine · Salón de Belleza — Guía de montaje completa

Este es el producto REAL: panel + agente de WhatsApp que agenda solo, confirma citas y recuerda a las clientas. Son 3 piezas que trabajan juntas.

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   PANEL     │────▶│   SUPABASE   │◀────│   BACKEND   │
│ (la dueña   │     │ (base datos: │     │ (Baileys +  │
│  configura) │     │  citas, etc) │     │  Groq)      │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                 │
                                          ┌──────▼──────┐
                                          │  WhatsApp   │
                                          │ (nº salón)  │
                                          └─────────────┘
```

---

## PASO 1 — Base de datos (Supabase) · 10 min

1. Entra a **https://supabase.com**, crea un proyecto nuevo (gratis).
2. Ve a **SQL Editor** → pega TODO el contenido de `backend/schema.sql` → **Run**.
   Luego pega también `backend/migracion_v3.sql` → **Run** (agrega el soporte
   de handoff humano; no borra nada). Ver detalles en `backend/MEJORAS.md`.
3. Ve a **Project Settings → API** y copia:
   - **URL** del proyecto (ej: `https://xxxxx.supabase.co`)
   - **anon public key** (para el panel)
   - **service_role key** (para el backend — es secreta, no la compartas)

> El schema crea las 7 tablas y un negocio de ejemplo que la dueña personaliza desde el panel.

---

## PASO 2 — Backend del agente (Railway) · 15 min

El backend conecta el WhatsApp con el cerebro. Va en un servidor que corra 24/7.

1. Sube la carpeta `backend/` a un repositorio de GitHub (privado).
2. En **Railway → New Project → Deploy from GitHub** → elige el repo.
3. En **Variables**, agrega:
   - `GROQ_API_KEY` = tu key de console.groq.com
   - `SUPABASE_URL` = la URL de Supabase
   - `SUPABASE_SERVICE_KEY` = la **service_role** key (no la anon)
4. Deploy. Cuando arranque, ve a los **logs (Deployments → View logs)**.
5. Aparecerá un **código QR** en los logs. 

### ⚠️ CRÍTICO — El escaneo del QR
- Escanea ese QR desde **WhatsApp → Dispositivos vinculados**, usando el **número DEDICADO del salón** (un chip aparte, NO el WhatsApp personal de la dueña).
- **Por qué:** Baileys tiene riesgo de baneo. Si el número se banea, con un número dedicado la dueña NO pierde su WhatsApp personal ni sus contactos — solo se cambia el número del bot.
- Una vez escaneado, verás "✅ WhatsApp conectado. El agente está atendiendo."

> Railway a veces corta los logs largos. Si no ves el QR completo, reinicia el deploy y míralo apenas arranca.

---

## PASO 3 — Panel de la dueña (cPanel o Netlify) · 5 min

El panel es donde la dueña configura todo y ve sus citas.

1. En `panel/index.html` NO hay que tocar nada.
2. Sube los 2 archivos (`index.html` y `app.js`) a una carpeta en tu hosting (cPanel: `public_html/salon-nombre/`, o arrástralos a Netlify).
3. La dueña abre esa URL. La primera vez le pide:
   - **URL de Supabase**
   - **anon key** (la public, NO la service)
4. Se conecta y ya administra todo. (Los datos de conexión se guardan solo en su dispositivo.)

> Cada salón cliente tiene su propio Supabase + su propio backend + su propia URL de panel. Es un sistema por cliente.

---

## PASO 4 — Configurar el cerebro (la dueña, 15 min)

Para que el agente NO invente y responda bien, la dueña llena en el panel:
1. **Mi negocio:** nombre, dirección, ciudad.
2. **Servicios y precios:** cada servicio con precio y duración.
3. **Horarios:** cuándo atiende cada día.
4. **Cerebro del agente:** el contexto del salón, las reglas, política de cancelación. Y activa el **control anti-invención**.
5. **Preguntas frecuentes:** respuestas exactas a lo que más preguntan.

Entre más complete, mejor responde el agente y menos inventa.

---

## CÓMO FUNCIONA (el flujo completo)

1. Una clienta escribe al WhatsApp del salón.
2. El backend recibe el mensaje, lee la config del panel (servicios, reglas, FAQs).
3. Groq arma la respuesta con esa info (sin inventar) y responde como una persona real, con delay humano.
4. Si la clienta quiere agendar, el agente calcula los horarios libres (según horario del salón y citas ocupadas) y se los ofrece numerados.
5. La clienta elige un número, y el agente agenda la cita → aparece en el calendario del panel.
6. El día antes, a las 10am, el sistema envía el recordatorio automático (anti no-show).

---

## PROTECCIONES ANTI-BANEO (sistema inteligente incluido)

El backend trae `antiban.js`, un sistema basado en las señales REALES que usa la detección de WhatsApp en 2026 (según investigación de la industria, no mitos). Ataca las 4 señales que de verdad pesan:

1. **Reply-ratio (la señal #1):** el sistema solo manda mensajes proactivos (recordatorios) a contactos que YA escribieron. Nunca a extraños. Mandar a extraños es lo que más banea.
2. **Timing humano:** delays gaussianos variables (nunca fijos). El intervalo fijo de 500ms es una señal documentada de bot. Además simula "escribiendo…" con micro-pausas naturales, como alguien que piensa mientras escribe.
3. **Velocidad controlada:** máximo ~25 mensajes/hora, con **warmup de 7 días** para números nuevos (arranca en 40/día y sube gradual). Los números nuevos que mandan mucho de golpe se banean rápido.
4. **Ritmo circadiano:** responde más lento de noche y en horas de comida. Actividad idéntica 24/7 es patrón de bot.

**Health monitor:** detecta errores 403 y desconexiones, y **auto-pausa el envío antes de que caiga el baneo** (30 min tras un 403). Puedes ver el estado en la URL del backend + `/estado`.

### Reglas de oro que TÚ debes cumplir (el código no puede solo):
- **SIEMPRE número dedicado** (chip aparte), NUNCA el WhatsApp personal de la dueña.
- **No importes contactos ni mandes campañas** desde ese número. Solo debe responder a quien escribe.
- **Deja el número "reposar" los primeros días** — que reciba pocos mensajes reales antes de escalar.
- Si `/estado` muestra errores 403 o pausas frecuentes, **para y avísame** — es señal de alerta temprana.

> Aun con todo esto, Baileys tiene riesgo real (es no-oficial). El sistema lo REDUCE mucho, no lo elimina. Un número stress-testeado con estas técnicas aguantó 1000 mensajes sin baneo, pero no hay garantía. La solución definitiva sin riesgo es la WhatsApp Cloud API oficial — tenla como plan para cuando esto crezca.

---

## MANTENIMIENTO

- Si la dueña cambia servicios/reglas, el backend refresca su config sola cada 60 segundos (o llama a `POST /refrescar-config`).
- Para ver si el agente está conectado: abre la URL del backend + `/estado`.
- Si el agente deja de responder, revisa los logs de Railway (puede haberse desconectado el WhatsApp → reescanear QR).
