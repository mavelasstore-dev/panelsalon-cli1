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

import baileys from '@whiskeysockets/baileys';
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import express from 'express';
import cron from 'node-cron';
import fs from 'fs';

import { pensar, getConfig, invalidarCache, clienteYaAgendo } from './cerebro.js';
import {
  supa, guardarMensaje, getHistorial, upsertCliente,
  citasParaRecordar, marcarRecordatorioEnviado
} from './db.js';
import {
  initAntiban, calcularDelay, registrarEntrante, puedeIniciarConversacion,
  puedeEnviar, registrarEnviado, reportarError, estadoSalud, simularEscritura
} from './antiban.js';

const logger = pino({ level: 'warn' });
let sock = null;

// Ruta donde se guarda la sesión de WhatsApp.
// En Railway debe apuntar a un VOLUMEN PERSISTENTE (/app/auth) para que
// la sesión NO se pierda entre deploys/reinicios. Configurable por env.
const AUTH_DIR = process.env.AUTH_DIR || '/app/auth';

// Revisa si ya existe una sesión guardada (archivo creds.json de Baileys).
// Sirve para distinguir un logout real de un primer arranque sin sesión.
function tieneCredenciales() {
  try {
    return fs.existsSync(AUTH_DIR + '/creds.json');
  } catch { return false; }
}

// Estado de conexión para exponerlo al panel
let estadoConexion = {
  conectado: false,
  qrDataURL: null,       // el QR como imagen (data:image/png;base64,...)
  qrTexto: null,         // el QR en texto (por si acaso)
  ultimoQR: 0,           // timestamp del último QR generado
  numero: null           // número conectado, cuando ya lo está
};

// Estado de agendamiento por cliente (cuando está eligiendo horario)
// Estado de seguimientos programados por cliente (para el flujo de link)

// ---------- UTILIDAD: delay ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
// (el cálculo de delays humanos ahora vive en antiban.js)

// ---------- CONEXIÓN WHATSAPP (robusta) ----------
let intentosReconexion = 0;
let reconectando = false;
let logoutsSeguidos = 0;   // cuenta logouts en bucle para limpiar sesión corrupta

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
            // Contamos los logouts seguidos. Si se repite, la sesión del
            // volumen está corrupta: la borramos UNA vez y arrancamos limpio.
            logoutsSeguidos++;
            console.log(`🚪 Logout detectado (${logoutsSeguidos}). Borrando sesión corrupta del volumen…`);
            try { await fs.promises.rm(AUTH_DIR, { recursive: true, force: true }); } catch {}
            try { await fs.promises.mkdir(AUTH_DIR, { recursive: true }); } catch {}
            reconectando = false;
            // tras borrar, la próxima conexión NO tendrá credenciales → generará QR
            const espera = logoutsSeguidos > 3 ? 8000 : 2000;
            setTimeout(conectar, espera);
            return;
          } else {
            // No hay sesión: es normal al inicio. Reconectar SIN borrar,
            // esperando que se genere el QR. Con tope para no saturar.
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
    // Si falla el arranque de la conexión, reintenta con backoff
    reconectando = false;
    intentosReconexion++;
    const espera = Math.min(60000, 3000 * Math.pow(2, Math.min(intentosReconexion - 1, 5)));
    console.error(`❌ Error al iniciar conexión: ${e.message}. Reintento en ${Math.round(espera/1000)}s…`);
    setTimeout(conectar, espera);
  }
}

// ---------- MANEJO DE MENSAJE ENTRANTE ----------
async function manejarMensaje(msg) {
  // Ignorar: propios, grupos, estados, vacíos
  if (msg.key.fromMe) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return;

  const texto = (msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || msg.message?.imageMessage?.caption
    || '').trim();
  if (!texto) return;

  const telefono = jid.split('@')[0];
  const nombre = msg.pushName || '';

  registrarEntrante(telefono);  // reply-ratio: este contacto SÍ nos escribió
  await upsertCliente(telefono, nombre);
  await guardarMensaje(telefono, nombre, 'user', texto);

  // ¿La clienta dijo que YA agendó? → cancelar cualquier seguimiento pendiente
  if (clienteYaAgendo(texto)) {
    cancelarSeguimiento(telefono);
  }

  // Consultar al cerebro
  const historial = await getHistorial(telefono);
  const { texto: respuesta, enviarLink, cfg } = await pensar(historial);

  await responderHumano(jid, telefono, nombre, respuesta);

  // Si el agente detectó intención de agendar → enviar el link + programar seguimiento
  if (enviarLink) {
    await enviarLinkAgendamiento(jid, telefono, nombre, cfg);
  }
}

// ---------- ENVIAR LINK DE AGENDAMIENTO ----------
async function enviarLinkAgendamiento(jid, telefono, nombre, cfg) {
  const link = cfg.negocio.link_agendamiento;
  if (!link) {
    console.warn('⚠️ No hay link de agendamiento configurado en el panel.');
    return;
  }
  // Enviar el link como mensaje aparte (se ve más claro y clickeable)
  await sleep(1200 + Math.random() * 800);
  await responderHumano(jid, telefono, nombre, `Aquí puede apartar su cupo 👇\n${link}`);

  // Programar el SEGUIMIENTO inteligente (si está activo)
  if (cfg.negocio.seguimiento_activo !== false) {
    programarSeguimiento(jid, telefono, nombre, cfg);
  }
}

// ---------- SEGUIMIENTO INTELIGENTE ----------
// Si a los X minutos la clienta no confirmó que agendó, el agente le
// escribe preguntando, con urgencia suave de cupos.
const seguimientos = {}; // { telefono: timeoutId }

function programarSeguimiento(jid, telefono, nombre, cfg) {
  cancelarSeguimiento(telefono); // no duplicar
  const minutos = cfg.negocio.seguimiento_minutos || 8;
  const ms = minutos * 60000;

  seguimientos[telefono] = setTimeout(async () => {
    delete seguimientos[telefono];
    try {
      // Reviso el historial reciente: ¿la clienta ya dijo que agendó
      // o escribió algo después del link? Si escribió "ya agendé", no molesto.
      const hist = await getHistorial(telefono, 6);
      const ultimosCliente = hist.filter(m => m.role === 'user').map(m => m.content);
      const ultimoDelCliente = ultimosCliente[ultimosCliente.length - 1] || '';
      if (clienteYaAgendo(ultimoDelCliente)) return; // ya agendó, no molestar

      // Mensaje de seguimiento (personalizable desde el panel)
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
  if (!texto) return;

  // Control de velocidad: ¿podemos enviar sin arriesgar el número?
  const permiso = puedeEnviar();
  if (!permiso.ok) {
    console.warn('⏸️  Envío pospuesto (' + permiso.razon + '). Protegiendo el número.');
    // esperamos un poco y reintentamos una vez (no perdemos el mensaje)
    await sleep(8000 + Math.random() * 7000);
    const permiso2 = puedeEnviar();
    if (!permiso2.ok) { console.warn('⏸️  Sigue en límite, se omite este envío.'); return; }
  }

  try {
    // Animación de escritura humana (con micro-pausas naturales)
    await simularEscritura(sock, jid, texto, sleep);
    await sock.sendMessage(jid, { text: texto });
    registrarEnviado();
    await guardarMensaje(telefono, nombre, 'assistant', texto);
  } catch (e) {
    // Detecta errores serios (403 = señal de baneo inminente)
    const msg = (e.message || '').toLowerCase();
    if (msg.includes('403') || msg.includes('forbidden')) reportarError('403');
    console.error('Error al enviar:', e.message);
  }
}

// ---------- RECORDATORIOS AUTOMÁTICOS (anti no-show) ----------
async function enviarRecordatorios() {
  if (!sock) return;
  try {
    const citas = await citasParaRecordar();
    for (const cita of citas) {
      if (!cita.cliente_telefono) continue;

      // ANTI-BANEO: solo mandamos recordatorio a quien YA nos escribió
      // (mandar a "extraños" es la señal #1 de baneo). Como la cita
      // se agendó por chat, el contacto ya interactuó — pero verificamos.
      if (!puedeIniciarConversacion(cita.cliente_telefono)) {
        // el contacto no está en memoria de esta sesión: lo registramos
        // como válido porque agendó una cita (interacción previa real)
        registrarEntrante(cita.cliente_telefono);
      }
      // Respeta el control de velocidad
      const permiso = puedeEnviar();
      if (!permiso.ok) { console.warn('⏸️ Recordatorios pausados (' + permiso.razon + ').'); break; }

      const jid = cita.cliente_telefono + '@s.whatsapp.net';
      const msg = `¡Hola${cita.cliente_nombre ? ' ' + cita.cliente_nombre.split(' ')[0] : ''}! 😊 Le recuerdo su cita de mañana a las ${cita.hora.slice(0,5)}${cita.servicio_nombre ? (' para ' + cita.servicio_nombre.toLowerCase()) : ''}. ¿Me confirma que sí asiste? 🙌`;

      await simularEscritura(sock, jid, msg, sleep);
      await sock.sendMessage(jid, { text: msg });
      registrarEnviado();
      await guardarMensaje(cita.cliente_telefono, cita.cliente_nombre, 'assistant', msg);
      await marcarRecordatorioEnviado(cita.id);
      // espacia bien los envíos (velocity): 20-40s entre recordatorios
      await sleep(20000 + Math.random() * 20000);
    }
    if (citas.length) console.log(`📨 Recordatorios procesados.`);
  } catch (e) { console.error('Error en recordatorios:', e.message); }
}

// ---------- SERVIDOR (health + refrescar config) ----------
const app = express();
app.use(express.json());

// CORS: permite que el panel (en cPanel/otro dominio) consulte este backend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (_, res) => res.send('Karl Salón backend activo ✅'));

// Estado de conexión (para el panel: sabe si mostrar QR o "conectado")
app.get('/estado', (_, res) => res.json({
  conectado: estadoConexion.conectado,
  numero: estadoConexion.numero,
  antiban: estadoSalud()
}));

// El QR como imagen, para mostrarlo en el panel
app.get('/qr', (_, res) => {
  if (estadoConexion.conectado) {
    return res.json({ conectado: true, qr: null });
  }
  res.json({
    conectado: false,
    qr: estadoConexion.qrDataURL,        // data:image/png;base64,... o null si aún no hay
    edad: estadoConexion.ultimoQR ? Date.now() - estadoConexion.ultimoQR : null
  });
});

// Desvincular WhatsApp (para reconectar con otro número)
app.post('/desvincular', async (_, res) => {
  try {
    if (sock) { await sock.logout().catch(()=>{}); }
    estadoConexion.conectado = false;
    estadoConexion.qrDataURL = null;
    res.json({ ok: true });
    setTimeout(conectar, 2000); // reinicia para generar QR nuevo
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/refrescar-config', (_, res) => { invalidarCache(); res.json({ ok: true }); });

// ============================================================
// RESET DE SESIÓN: borra la sesión guardada en el volumen y
// fuerza un QR nuevo y limpio. Úsalo si el WhatsApp entra en
// loop de "logout". Abre en el navegador: <url>/reset-sesion
// ============================================================
app.get('/reset-sesion', async (_, res) => {
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
    res.json({ ok: false, error: e.message });
  }
});

// ============================================================
// DIAGNÓSTICO: verifica cada pieza del sistema en vivo
// Abre en el navegador: <url>/diagnostico
// ============================================================
app.get('/diagnostico', async (_, res) => {
  const check = { fecha: new Date().toISOString(), pruebas: {} };

  // 1. WhatsApp conectado
  check.pruebas.whatsapp = {
    ok: estadoConexion.conectado,
    detalle: estadoConexion.conectado
      ? `Conectado como ${estadoConexion.numero || 'número vinculado'}`
      : 'NO conectado. Escanea el QR en el panel.'
  };

  // 2. Supabase: leer config
  try {
    const cfg = await getConfig();
    const nServicios = cfg.servicios.length;
    const tieneLink = !!cfg.negocio.link_agendamiento;
    check.pruebas.supabase_lectura = {
      ok: true,
      detalle: `Lee OK. Negocio: "${cfg.negocio.nombre}". Servicios cargados: ${nServicios}. Link agendamiento: ${tieneLink ? 'SÍ' : 'NO (falta configurarlo)'}`
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

  // 3. Supabase: escribir (prueba real de escritura y borrado)
  try {
    const testTel = '_diagnostico_test_';
    await guardarMensaje(testTel, 'Diagnóstico', 'user', 'mensaje de prueba');
    await supa.from('conversaciones').delete().eq('cliente_telefono', testTel);
    check.pruebas.supabase_escritura = { ok: true, detalle: 'Escribe y borra OK en la base de datos' };
  } catch (e) {
    check.pruebas.supabase_escritura = { ok: false, detalle: 'ERROR al escribir: ' + e.message };
  }

  // 4. Groq: el cerebro piensa
  try {
    const r = await pensar([{ role: 'user', content: 'hola, ¿están abiertos?' }]);
    check.pruebas.cerebro_groq = {
      ok: !!r.texto && r.texto.length > 2,
      detalle: r.texto ? `Groq responde OK. Ejemplo: "${r.texto.slice(0, 80)}"` : 'Groq NO generó respuesta'
    };
  } catch (e) {
    check.pruebas.cerebro_groq = { ok: false, detalle: 'ERROR en Groq: ' + e.message };
  }

  // 5. Anti-baneo
  check.pruebas.antiban = { ok: true, detalle: estadoSalud() };

  // 6. Persistencia de sesión (volumen)
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

  // Resumen
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

// ============================================================
// TEST DEL AGENTE: simula una conversación completa
// Abre: <url>/test-agente?mensaje=quiero la keratina
// ============================================================
app.get('/test-agente', async (req, res) => {
  const mensaje = req.query.mensaje || 'hola, quiero agendar una cita';
  try {
    const resultado = await pensar([{ role: 'user', content: mensaje }]);
    res.json({
      tu_mensaje: mensaje,
      respuesta_del_agente: resultado.texto,
      va_a_enviar_link: resultado.enviarLink,
      link_configurado: resultado.cfg.negocio.link_agendamiento || '(no configurado)',
      explicacion: resultado.enviarLink
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
cron.schedule('0 10 * * *', enviarRecordatorios, { timezone: 'America/Bogota' });

// ---------- ARRANQUE ----------
console.log('🚀 Iniciando Karl Salón backend…');
initAntiban();
conectar();
