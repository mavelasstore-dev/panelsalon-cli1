// ============================================================
// index.js — Backend principal del agente de salón
// Baileys (WhatsApp) + Groq (cerebro) + Supabase (datos)
//
// PROTECCIONES ANTI-BANEO incluidas:
// - Delays humanos variables antes de responder
// - Simulación de "escribiendo..." (presence)
// - Solo responde a chats individuales (no grupos)
// - Usar SIEMPRE en un número dedicado, NO el personal de la dueña
// ============================================================

import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import express from 'express';
import cron from 'node-cron';
import fs from 'fs';

import { pensar, getConfig, invalidarCache, clienteYaAgendo, pideHumano } from './cerebro.js';
import {
  supa, guardarMensaje, getHistorial, upsertCliente,
  citasParaRecordar, marcarRecordatorioEnviado,
  getPausaCliente, setPausaCliente, TZ
} from './db.js';
import {
  initAntiban, calcularDelay, registrarEntrante, puedeIniciarConversacion,
  puedeEnviar, registrarEnviado, reportarError, estadoSalud, simularEscritura
} from './antiban.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
let sock = null;

// Token opcional para proteger endpoints sensibles (reset/desvincular/pausa).
// Si no se configura, se mantiene el comportamiento abierto (retrocompatible).
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Número de la dueña para avisos de handoff (ej: 573001234567). Opcional.
const NUMERO_DUENO = (process.env.NUMERO_DUENO || '').replace(/\D/g, '');

// Ruta donde se guarda la sesión de WhatsApp.
// En Railway debe apuntar a un VOLUMEN PERSISTENTE (/app/auth) para que
// la sesión NO se pierda entre deploys/reinicios. Configurable por env.
const AUTH_DIR = process.env.AUTH_DIR || '/app/auth';

// Revisa si ya existe una sesión guardada (archivo creds.json de Baileys).
function tieneCredenciales() {
  try { return fs.existsSync(AUTH_DIR + '/creds.json'); }
  catch { return false; }
}

// Estado de conexión para exponerlo al panel
let estadoConexion = {
  conectado: false,
  qrDataURL: null,       // el QR como imagen (data:image/png;base64,...)
  qrTexto: null,         // el QR en texto (por si acaso)
  ultimoQR: 0,           // timestamp del último QR generado
  numero: null           // número conectado, cuando ya lo está
};

// ---------- UTILIDAD: delay ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- CONEXIÓN WHATSAPP (robusta) ----------
let intentosReconexion = 0;
let reconectando = false;
let logoutsSeguidos = 0;        // cuenta logouts en bucle para limpiar sesión corrupta
let forzarLimpiezaSesion = false; // (bug arreglado: antes no se declaraba → /reset-sesion fallaba)

async function conectar() {
  // Evita reconexiones múltiples simultáneas (causa de loops)
  if (reconectando) return;
  reconectando = true;

  // Cierra y descarta cualquier socket anterior para no arrastrar
  // credenciales viejas en memoria (causa del loop de logout).
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch {}
    try { sock.end(undefined); } catch {}
    sock = null;
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Divinas Salon', 'Chrome', '120.0.0'],  // identidad estable del dispositivo
      markOnlineOnConnect: false,        // no marcar "en línea" siempre (más humano)
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      defaultQueryTimeoutMs: 0,          // 0 = sin límite en queries (evita el 408 de init)
      retryRequestDelayMs: 2000,
      emitOwnEvents: false,
      generateHighQualityLinkPreview: false,
      shouldSyncHistoryMessage: () => false
    });

    // Socket creado con éxito: liberamos el candado para permitir
    // reconexiones futuras (las maneja connection.update).
    reconectando = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        logoutsSeguidos = 0;  // llegó el QR: la sesión ya está limpia
        console.log('\n📱 QR generado. Escanéalo desde el panel (Mi negocio) o aquí:\n');
        qrcode.generate(qr, { small: true });
        try {
          estadoConexion.qrDataURL = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
          estadoConexion.qrTexto = qr;
          estadoConexion.ultimoQR = Date.now();
          estadoConexion.conectado = false;
        } catch (e) { console.error('Error generando QR imagen:', e.message); }
      }

      if (connection === 'connecting') {
        console.log('🔄 Conectando a WhatsApp…');
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        estadoConexion.conectado = false;

        // Si estamos forzando limpieza (reset manual), no reanimamos la sesión vieja.
        if (forzarLimpiezaSesion) {
          reconectando = false;
          return;
        }

        // 515 restartRequired: PASO NORMAL tras escanear el QR.
        if (code === DisconnectReason.restartRequired) {
          console.log('🔄 Reinicio requerido tras escanear (normal). Reconectando ya…');
          reconectando = false;
          setTimeout(conectar, 500);
          return;
        }

        // loggedOut (401): distinguir logout real de sesión corrupta en bucle.
        if (code === DisconnectReason.loggedOut) {
          const teniaSesion = tieneCredenciales();
          if (teniaSesion) {
            logoutsSeguidos++;
            console.log(`🚪 Logout detectado (${logoutsSeguidos}). Borrando sesión corrupta del volumen…`);
            try { await fs.promises.rm(AUTH_DIR, { recursive: true, force: true }); } catch {}
            try { await fs.promises.mkdir(AUTH_DIR, { recursive: true }); } catch {}
            reconectando = false;
            const espera = logoutsSeguidos > 3 ? 8000 : 2000;
            setTimeout(conectar, espera);
            return;
          } else {
            intentosReconexion++;
            reconectando = false;
            if (intentosReconexion > 10) {
              console.log('⏳ Muchos intentos sin QR. Pausa de 30s…');
              intentosReconexion = 0;
              setTimeout(conectar, 30000);
            } else {
              console.log(`📱 Esperando el QR (intento ${intentosReconexion})… debe aparecer en el panel.`);
              setTimeout(conectar, 3000);
            }
            return;
          }
        }

        // badSession (500): sesión corrupta → borrar y regenerar
        if (code === 500) {
          console.log('🧹 Sesión corrupta (badSession). Borrando y regenerando…');
          try { await fs.promises.rm(AUTH_DIR, { recursive: true, force: true }); } catch {}
          intentosReconexion = 0;
          reconectando = false;
          setTimeout(conectar, 1500);
          return;
        }

        // Otros (408 timeout, 428 cerrada, 440 reemplazada, 503…): reconectar con backoff
        reportarError('disconnect');
        if (code === 403) reportarError('403');

        intentosReconexion++;
        const espera = Math.min(30000, 2000 * Math.pow(2, Math.min(intentosReconexion - 1, 4)));
        const motivo = code === 408 ? 'timeout' : code === 428 ? 'conexión cerrada' : code === 440 ? 'sesión reemplazada' : `código ${code}`;
        console.log(`⚠️ Conexión cerrada (${motivo}). Reintento #${intentosReconexion} en ${Math.round(espera/1000)}s…`);
        reconectando = false;
        setTimeout(conectar, espera);
      } else if (connection === 'open') {
        intentosReconexion = 0;  // resetea el contador al conectar bien
        logoutsSeguidos = 0;
        reconectando = false;
        estadoConexion.conectado = true;
        estadoConexion.qrDataURL = null;
        estadoConexion.qrTexto = null;
        estadoConexion.numero = sock?.user?.id || null;
        console.log('✅ WhatsApp conectado. El agente está atendiendo.');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try { await manejarMensaje(msg); }
        catch (e) { console.error('Error manejando mensaje:', e.message); }
      }
    });

  } catch (e) {
    reconectando = false;
    intentosReconexion++;
    const espera = Math.min(60000, 3000 * Math.pow(2, Math.min(intentosReconexion - 1, 5)));
    console.error(`❌ Error al iniciar conexión: ${e.message}. Reintento en ${Math.round(espera/1000)}s…`);
    setTimeout(conectar, espera);
  }
}

// ============================================================
// MANEJO DE MENSAJE ENTRANTE
// ============================================================

// Dedup: WhatsApp puede re-entregar mensajes al reconectar. Evitamos
// procesar (y responder) el mismo mensaje dos veces.
const idsVistos = new Set();
const avisoMediaEn = {}; // telefono -> timestamp del último aviso "solo texto"
function yaProcesado(id) {
  if (!id) return false;
  if (idsVistos.has(id)) return true;
  idsVistos.add(id);
  // cap de memoria: conservamos los últimos ~2000 ids
  if (idsVistos.size > 2000) {
    const it = idsVistos.values();
    for (let i = 0; i < 500; i++) idsVistos.delete(it.next().value);
  }
  return false;
}

// Extrae texto de los tipos de mensaje soportados
function extraerTexto(msg) {
  return (msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || msg.message?.imageMessage?.caption
    || msg.message?.videoMessage?.caption
    || '').trim();
}

// ¿El mensaje trae contenido multimedia que NO sabemos leer (audio, sticker…)?
function esMultimediaSinTexto(msg) {
  const m = msg.message || {};
  return !!(m.audioMessage || m.pttMessage || m.stickerMessage
    || (m.imageMessage && !m.imageMessage.caption)
    || (m.videoMessage && !m.videoMessage.caption)
    || m.documentMessage || m.locationMessage || m.contactMessage);
}

async function manejarMensaje(msg) {
  // Ignorar: propios, grupos, estados, broadcasts
  if (msg.key.fromMe) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid === 'status@broadcast') return;
  if (jid.endsWith('@newsletter')) return; // canales

  // Dedup por id de mensaje
  if (yaProcesado(msg.key.id)) return;

  const telefono = jid.split('@')[0];
  const nombre = msg.pushName || '';
  const texto = extraerTexto(msg);

  // Mensaje sin texto legible (audio/sticker/etc.): respuesta cortés,
  // con cooldown para no repetir el aviso si mandan varios seguidos.
  if (!texto) {
    if (esMultimediaSinTexto(msg)) {
      registrarEntrante(telefono);
      await upsertCliente(telefono, nombre);
      if (await chatPausado(telefono)) return;
      const ahora = Date.now();
      if (ahora - (avisoMediaEn[telefono] || 0) < 90000) return; // ya avisamos hace <90s
      avisoMediaEn[telefono] = ahora;
      await responderHumano(jid, telefono, nombre,
        'Por ahora solo puedo leer mensajes de texto 😊 ¿Me cuenta por aquí en qué le ayudo?');
    }
    return;
  }

  registrarEntrante(telefono);  // reply-ratio: este contacto SÍ nos escribió
  await upsertCliente(telefono, nombre);
  await guardarMensaje(telefono, nombre, 'user', texto);

  // ¿La clienta dijo que YA agendó? → cancelar cualquier seguimiento pendiente
  if (clienteYaAgendo(texto)) cancelarSeguimiento(telefono);

  // Si pide expresamente un humano, escalamos aunque el modelo no lo detecte.
  const pedidoHumanoDirecto = pideHumano(texto);

  // Encola para responder con debounce (agrupa mensajes rápidos → 1 respuesta)
  encolarRespuesta(jid, telefono, nombre, pedidoHumanoDirecto);
}

// ============================================================
// DEBOUNCE + LOCK POR CONTACTO
// Si la clienta manda varios mensajes seguidos, esperamos un poco y
// respondemos UNA sola vez con todo el contexto. Evita respuestas dobles
// y solapadas (bug original).
// ============================================================
const DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS || 3500);
const pendientes = {};      // telefono -> { jid, nombre, timer, humano }
const enProceso = new Set();

function encolarRespuesta(jid, telefono, nombre, pedidoHumano = false) {
  const prev = pendientes[telefono];
  if (prev?.timer) clearTimeout(prev.timer);
  pendientes[telefono] = {
    jid, nombre,
    humano: (prev?.humano || pedidoHumano),
    timer: setTimeout(() => dispararRespuesta(telefono), DEBOUNCE_MS)
  };
}

async function dispararRespuesta(telefono) {
  const info = pendientes[telefono];
  if (!info) return;

  // Si ya estamos procesando este contacto, reprogramamos para después.
  if (enProceso.has(telefono)) {
    info.timer = setTimeout(() => dispararRespuesta(telefono), 1500);
    return;
  }
  delete pendientes[telefono];
  enProceso.add(telefono);

  try {
    // Handoff: si un humano tomó el chat, el agente calla.
    if (await chatPausado(telefono)) {
      console.log(`⏸️  Chat de ${telefono} en manos de un humano. El agente no responde.`);
      return;
    }

    const historial = await getHistorial(telefono);
    const { texto: respuesta, enviarLink, handoff, cfg } = await pensar(historial);

    await responderHumano(info.jid, telefono, info.nombre, respuesta);

    // Escalar a humano (por decisión del modelo o petición directa)
    if (handoff || info.humano) {
      await escalarAHumano(info.jid, telefono, info.nombre, cfg);
      return; // no enviamos link ni seguimos vendiendo
    }

    // Intención de agendar → enviar link + programar seguimiento
    if (enviarLink) await enviarLinkAgendamiento(info.jid, telefono, info.nombre, cfg);

  } catch (e) {
    console.error('Error generando respuesta:', e.message);
  } finally {
    enProceso.delete(telefono);
    // Si llegaron mensajes nuevos mientras procesábamos, atendemos pronto.
    if (pendientes[telefono] && !pendientes[telefono].timer) {
      pendientes[telefono].timer = setTimeout(() => dispararRespuesta(telefono), 600);
    }
  }
}

// ---------- HANDOFF A HUMANO ----------
async function chatPausado(telefono) {
  try {
    const cfg = await getConfig();
    if (cfg.negocio?.pausado_global) return true;   // pausa global desde el panel
    const p = await getPausaCliente(telefono);
    return !!p.pausado;
  } catch { return false; }
}

async function escalarAHumano(jid, telefono, nombre, cfg) {
  cancelarSeguimiento(telefono);
  // Pausa el agente en este chat por unas horas para que atienda la persona.
  const minutos = Number(cfg?.negocio?.handoff_minutos || 120);
  await setPausaCliente(telefono, true, minutos);
  console.log(`🙋 Handoff activado para ${telefono} (${minutos} min).`);

  // Aviso a la dueña por WhatsApp (si configuró su número y ella ya nos escribió alguna vez)
  if (NUMERO_DUENO) {
    try {
      const jidDueno = NUMERO_DUENO + '@s.whatsapp.net';
      const aviso = `🔔 Una clienta necesita atención personal.\nNombre: ${nombre || 'sin nombre'}\nTel: ${telefono}\n(El agente se pausó en ese chat 2h.)`;
      await sock.sendMessage(jidDueno, { text: aviso });
      registrarEnviado();
    } catch (e) { console.error('No se pudo avisar a la dueña:', e.message); }
  }
}

// ---------- ENVIAR LINK DE AGENDAMIENTO ----------
async function enviarLinkAgendamiento(jid, telefono, nombre, cfg) {
  const link = cfg.negocio.link_agendamiento;
  if (!link) {
    console.warn('⚠️ No hay link de agendamiento configurado en el panel.');
    return;
  }
  await sleep(1200 + Math.random() * 800);
  await responderHumano(jid, telefono, nombre, `Aquí puede apartar su cupo 👇\n${link}`);

  if (cfg.negocio.seguimiento_activo !== false) {
    programarSeguimiento(jid, telefono, nombre, cfg);
  }
}

// ---------- SEGUIMIENTO INTELIGENTE ----------
// Si a los X minutos la clienta no confirmó que agendó, el agente le
// escribe preguntando, con urgencia suave de cupos.
const seguimientos = {}; // { telefono: timeoutId }

function programarSeguimiento(jid, telefono, nombre, cfg) {
  cancelarSeguimiento(telefono);
  const minutos = cfg.negocio.seguimiento_minutos || 8;
  const ms = minutos * 60000;

  seguimientos[telefono] = setTimeout(async () => {
    delete seguimientos[telefono];
    try {
      // ¿el chat lo tomó un humano? no molestamos
      if (await chatPausado(telefono)) return;

      const hist = await getHistorial(telefono, 6);
      const ultimosCliente = hist.filter(m => m.role === 'user').map(m => m.content);
      const ultimoDelCliente = ultimosCliente[ultimosCliente.length - 1] || '';
      if (clienteYaAgendo(ultimoDelCliente)) return; // ya agendó, no molestar

      const nombreCorto = nombre ? ' ' + nombre.split(' ')[0] : '';
      const msg = cfg.negocio.mensaje_cupos
        ? cfg.negocio.mensaje_cupos.replace('{nombre}', nombreCorto)
        : `¿Pudo apartar su cita${nombreCorto}? 😊 Le pregunto porque se están llenando los cupos y no quiero que se quede sin el suyo 🙈`;

      await responderHumano(jid, telefono, nombre, msg);
    } catch (e) { console.error('Error en seguimiento:', e.message); }
  }, ms);
}

function cancelarSeguimiento(telefono) {
  if (seguimientos[telefono]) {
    clearTimeout(seguimientos[telefono]);
    delete seguimientos[telefono];
  }
}

// ---------- RESPONDER CON COMPORTAMIENTO HUMANO (anti-baneo) ----------
async function responderHumano(jid, telefono, nombre, texto) {
  if (!texto || !sock) return;

  const permiso = puedeEnviar();
  if (!permiso.ok) {
    console.warn('⏸️  Envío pospuesto (' + permiso.razon + '). Protegiendo el número.');
    await sleep(8000 + Math.random() * 7000);
    const permiso2 = puedeEnviar();
    if (!permiso2.ok) { console.warn('⏸️  Sigue en límite, se omite este envío.'); return; }
  }

  try {
    await simularEscritura(sock, jid, texto, sleep);
    await sock.sendMessage(jid, { text: texto });
    registrarEnviado();
    await guardarMensaje(telefono, nombre, 'assistant', texto);
  } catch (e) {
    const msg = (e.message || '').toLowerCase();
    if (msg.includes('403') || msg.includes('forbidden')) reportarError('403');
    console.error('Error al enviar:', e.message);
  }
}

// ---------- RECORDATORIOS AUTOMÁTICOS (anti no-show) ----------
async function enviarRecordatorios() {
  if (!sock || !estadoConexion.conectado) return;
  try {
    const citas = await citasParaRecordar();
    for (const cita of citas) {
      if (!cita.cliente_telefono) continue;

      if (!puedeIniciarConversacion(cita.cliente_telefono)) {
        // el contacto agendó una cita real → interacción previa válida
        registrarEntrante(cita.cliente_telefono);
      }
      const permiso = puedeEnviar();
      if (!permiso.ok) { console.warn('⏸️ Recordatorios pausados (' + permiso.razon + ').'); break; }

      const jid = cita.cliente_telefono + '@s.whatsapp.net';
      const msg = `¡Hola${cita.cliente_nombre ? ' ' + cita.cliente_nombre.split(' ')[0] : ''}! 😊 Le recuerdo su cita de mañana a las ${(cita.hora||'').slice(0,5)}${cita.servicio_nombre ? (' para ' + cita.servicio_nombre.toLowerCase()) : ''}. ¿Me confirma que sí asiste? 🙌`;

      await simularEscritura(sock, jid, msg, sleep);
      await sock.sendMessage(jid, { text: msg });
      registrarEnviado();
      await guardarMensaje(cita.cliente_telefono, cita.cliente_nombre, 'assistant', msg);
      await marcarRecordatorioEnviado(cita.id);
      await sleep(20000 + Math.random() * 20000); // 20-40s entre recordatorios
    }
    if (citas.length) console.log(`📨 Recordatorios procesados: ${citas.length}.`);
  } catch (e) { console.error('Error en recordatorios:', e.message); }
}

// ============================================================
// SERVIDOR (health + refrescar config)
// ============================================================
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Middleware de protección para endpoints sensibles.
// Si ADMIN_TOKEN no está configurado, no exige nada (retrocompatible).
function requiereToken(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const tok = req.get('X-Admin-Token') || req.query.token || (req.body && req.body.token);
  if (tok === ADMIN_TOKEN) return next();
  return res.status(401).json({ ok: false, error: 'No autorizado' });
}

app.get('/', (_, res) => res.send('Karl Salón backend activo ✅'));

app.get('/estado', (_, res) => res.json({
  conectado: estadoConexion.conectado,
  numero: estadoConexion.numero,
  antiban: estadoSalud()
}));

app.get('/qr', (_, res) => {
  if (estadoConexion.conectado) return res.json({ conectado: true, qr: null });
  res.json({
    conectado: false,
    qr: estadoConexion.qrDataURL,
    edad: estadoConexion.ultimoQR ? Date.now() - estadoConexion.ultimoQR : null
  });
});

app.post('/desvincular', requiereToken, async (_, res) => {
  try {
    if (sock) { await sock.logout().catch(()=>{}); }
    estadoConexion.conectado = false;
    estadoConexion.qrDataURL = null;
    res.json({ ok: true });
    setTimeout(conectar, 2000);
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/refrescar-config', requiereToken, (_, res) => { invalidarCache(); res.json({ ok: true }); });

// ---------- HANDOFF: pausar / reanudar el agente en un chat ----------
// El panel puede llamar a esto cuando la dueña quiere atender ella misma.
app.post('/pausar', requiereToken, async (req, res) => {
  const telefono = (req.body?.telefono || '').replace(/\D/g, '');
  const minutos = Number(req.body?.minutos) || null;
  if (!telefono) return res.status(400).json({ ok: false, error: 'Falta telefono' });
  const ok = await setPausaCliente(telefono, true, minutos);
  res.json({ ok });
});

app.post('/reanudar', requiereToken, async (req, res) => {
  const telefono = (req.body?.telefono || '').replace(/\D/g, '');
  if (!telefono) return res.status(400).json({ ok: false, error: 'Falta telefono' });
  const ok = await setPausaCliente(telefono, false);
  res.json({ ok });
});

// ---------- RESET DE SESIÓN (arreglado) ----------
app.get('/reset-sesion', requiereToken, async (_, res) => {
  try {
    forzarLimpiezaSesion = true;   // evita que el loop reviva la sesión vieja
    if (sock) { try { await sock.logout(); } catch {} try { sock.end(); } catch {} sock = null; }
    await fs.promises.rm(AUTH_DIR, { recursive: true, force: true }).catch(()=>{});
    await fs.promises.mkdir(AUTH_DIR, { recursive: true }).catch(()=>{});
    estadoConexion.conectado = false;
    estadoConexion.qrDataURL = null;
    estadoConexion.qrTexto = null;
    intentosReconexion = 0;
    reconectando = false;
    forzarLimpiezaSesion = false;
    setTimeout(conectar, 1500);
    res.json({ ok: true, mensaje: 'Sesión borrada del volumen. Generando QR nuevo… Abre el panel (Mi negocio) en unos segundos para escanearlo.' });
  } catch (e) {
    forzarLimpiezaSesion = false;
    res.json({ ok: false, error: e.message });
  }
});

// ---------- DIAGNÓSTICO ----------
app.get('/diagnostico', async (_, res) => {
  const check = { fecha: new Date().toISOString(), zona: TZ, pruebas: {} };

  check.pruebas.whatsapp = {
    ok: estadoConexion.conectado,
    detalle: estadoConexion.conectado
      ? `Conectado como ${estadoConexion.numero || 'número vinculado'}`
      : 'NO conectado. Escanea el QR en el panel.'
  };

  try {
    const cfg = await getConfig();
    const nServicios = cfg.servicios.length;
    const tieneLink = !!cfg.negocio.link_agendamiento;
    check.pruebas.supabase_lectura = {
      ok: true,
      detalle: `Lee OK. Negocio: "${cfg.negocio.nombre}". Servicios: ${nServicios}. Link agendamiento: ${tieneLink ? 'SÍ' : 'NO (falta configurarlo)'}`
    };
    check.pruebas.config_cerebro = {
      ok: nServicios > 0 && !!cfg.negocio.contexto,
      detalle: nServicios > 0 && cfg.negocio.contexto
        ? 'Cerebro configurado (tiene servicios y contexto)'
        : '⚠️ Cerebro incompleto: ' + (nServicios === 0 ? 'faltan servicios. ' : '') + (!cfg.negocio.contexto ? 'falta contexto.' : '')
    };
  } catch (e) {
    check.pruebas.supabase_lectura = { ok: false, detalle: 'ERROR: ' + e.message };
  }

  try {
    const testTel = '_diagnostico_test_';
    await guardarMensaje(testTel, 'Diagnóstico', 'user', 'mensaje de prueba');
    await supa.from('conversaciones').delete().eq('cliente_telefono', testTel);
    check.pruebas.supabase_escritura = { ok: true, detalle: 'Escribe y borra OK en la base de datos' };
  } catch (e) {
    check.pruebas.supabase_escritura = { ok: false, detalle: 'ERROR al escribir: ' + e.message };
  }

  try {
    const r = await pensar([{ role: 'user', content: 'hola, ¿están abiertos?' }]);
    check.pruebas.cerebro_groq = {
      ok: !!r.texto && r.texto.length > 2,
      detalle: r.texto ? `Groq responde OK. Ejemplo: "${r.texto.slice(0, 80)}"` : 'Groq NO generó respuesta'
    };
  } catch (e) {
    check.pruebas.cerebro_groq = { ok: false, detalle: 'ERROR en Groq: ' + e.message };
  }

  check.pruebas.antiban = { ok: true, detalle: estadoSalud() };

  try {
    const existe = fs.existsSync(AUTH_DIR);
    const archivos = existe ? fs.readdirSync(AUTH_DIR).length : 0;
    const conSesion = existe && fs.existsSync(AUTH_DIR + '/creds.json');
    check.pruebas.sesion_persistente = {
      ok: existe,
      detalle: `Carpeta: ${AUTH_DIR}. ${existe ? `Existe (${archivos} archivos).` : 'NO existe — falta el volumen en Railway.'} ${conSesion ? 'Sesión guardada ✅' : 'Sin sesión (escanea el QR).'}`
    };
  } catch (e) {
    check.pruebas.sesion_persistente = { ok: false, detalle: 'Error revisando sesión: ' + e.message };
  }

  const todas = Object.values(check.pruebas).filter(p => typeof p.ok === 'boolean');
  const pasaron = todas.filter(p => p.ok).length;
  check.resumen = {
    total: todas.length,
    pasaron,
    fallaron: todas.length - pasaron,
    veredicto: pasaron === todas.length
      ? '✅ TODO FUNCIONA. El agente está listo para atender.'
      : `⚠️ ${todas.length - pasaron} prueba(s) fallaron. Revisa los detalles arriba.`
  };

  res.json(check);
});

// ---------- TEST DEL AGENTE ----------
app.get('/test-agente', async (req, res) => {
  const mensaje = req.query.mensaje || 'hola, quiero agendar una cita';
  try {
    const resultado = await pensar([{ role: 'user', content: mensaje }]);
    res.json({
      tu_mensaje: mensaje,
      respuesta_del_agente: resultado.texto,
      va_a_enviar_link: resultado.enviarLink,
      va_a_escalar_a_humano: resultado.handoff,
      link_configurado: resultado.cfg.negocio.link_agendamiento || '(no configurado)',
      explicacion: resultado.handoff
        ? 'El agente detectó que este caso necesita atención humana.'
        : resultado.enviarLink
          ? 'El agente detectó intención de agendar y enviaría el link después de este mensaje.'
          : 'El agente respondió conversando. No detectó intención de agendar todavía (o pidió más info).'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🌐 Servidor en puerto ' + PORT));

// ---------- CRON: recordatorios cada día a las 10am ----------
cron.schedule('0 10 * * *', enviarRecordatorios, { timezone: TZ });

// ---------- MANEJO GLOBAL DE ERRORES (que un fallo no tumbe el proceso) ----------
process.on('unhandledRejection', (r) => console.error('⚠️ unhandledRejection:', r?.message || r));
process.on('uncaughtException', (e) => console.error('⚠️ uncaughtException:', e?.message || e));

// ---------- ARRANQUE ----------
console.log('🚀 Iniciando Karl Salón backend…');
initAntiban();
conectar();
