// ============================================================
// antiban.js — Sistema anti-baneo inteligente
//
// Basado en las señales REALES que usa la detección de
// WhatsApp en 2026 (no en mitos). Ataca las 4 señales que
// de verdad pesan en el ML de Meta:
//
//  1. REPLY-RATIO: solo iniciamos conversación con quien
//     ya nos escribió. Nunca "spray-and-pray" a extraños.
//  2. TIMING: delays gaussianos variables (nunca fijos).
//     El intervalo fijo de 500ms es señal de bot.
//  3. VELOCITY: límite de mensajes por hora y por día,
//     con warmup de 7 días para números nuevos.
//  4. RITMO CIRCADIANO: más lento de noche, respeta el
//     horario humano. Actividad 24/7 = patrón de bot.
//
//  + Health monitor: detecta 403/desconexiones y auto-pausa
//    antes de que caiga el baneo.
// ============================================================

// ---------- CONFIG (ajustable) ----------
const CONFIG = {
  maxPorHora: 25,          // < 30/h recomendado
  maxPorDiaBase: 200,      // tope diario cuando ya está "caliente"
  warmupDias: 7,           // días de calentamiento de número nuevo
  warmupInicial: 40,       // mensajes/día el día 1 de un número nuevo
  minDelayMs: 1600,        // nunca responder más rápido que esto
  maxDelayMs: 7000,        // tope de espera
  ventanaNoche: [22, 7],   // horas [inicio, fin] de "noche" (más lento)
};

// ---------- ESTADO ----------
const estado = {
  fechaInicio: null,        // cuándo se conectó el número (para warmup)
  enviados: [],             // timestamps de envíos (para velocity)
  pausadoHasta: 0,          // si hay auto-pausa por health
  contactosQueEscribieron: new Set(), // reply-ratio: solo a estos iniciamos
  salud: { desconexiones: 0, errores403: 0, ultimoError: null }
};

export function initAntiban() {
  estado.fechaInicio = Date.now();
  console.log('🛡️  Anti-ban activo. Modo warmup los primeros ' + CONFIG.warmupDias + ' días.');
}

// ---------- WARMUP: límite diario según antigüedad del número ----------
function limiteHoy() {
  if (!estado.fechaInicio) return CONFIG.warmupInicial;
  const dias = Math.floor((Date.now() - estado.fechaInicio) / 86400000);
  if (dias >= CONFIG.warmupDias) return CONFIG.maxPorDiaBase;
  // rampa lineal de warmupInicial → maxPorDiaBase durante warmupDias
  const t = dias / CONFIG.warmupDias;
  return Math.round(CONFIG.warmupInicial + t * (CONFIG.maxPorDiaBase - CONFIG.warmupInicial));
}

// ---------- MULTIPLICADOR CIRCADIANO ----------
// De noche respondemos más lento (patrón humano). Nadie contesta
// igual de rápido a las 3am que a las 3pm.
function multiplicadorCircadiano() {
  const h = new Date().getHours();
  const [ini, fin] = CONFIG.ventanaNoche;
  const esNoche = (ini > fin) ? (h >= ini || h < fin) : (h >= ini && h < fin);
  if (esNoche) return 2.2;                 // mucho más lento de noche
  if (h >= 7 && h < 9) return 1.4;         // temprano, despertando
  if (h >= 12 && h < 14) return 1.3;       // almuerzo
  return 1.0;                              // horario activo normal
}

// ---------- DELAY GAUSSIANO (no fijo) ----------
// El intervalo fijo es señal de bot. Usamos distribución normal.
function gaussian(mean, stdev) {
  let u = 1 - Math.random(), v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * stdev;
}

// Calcula cuánto esperar antes de responder, según longitud del texto
// (simula lectura + escritura humana) y ritmo circadiano.
export function calcularDelay(texto) {
  const largo = (texto || '').length;
  // tiempo de "leer lo que le escribieron" + "escribir la respuesta"
  const base = 1400 + largo * 42;                 // ~42ms por caracter
  const conRuido = gaussian(base, base * 0.28);   // ±28% variación gaussiana
  const circadiano = conRuido * multiplicadorCircadiano();
  return Math.max(CONFIG.minDelayMs, Math.min(CONFIG.maxDelayMs, Math.round(circadiano)));
}

// ---------- REGISTRAR QUE UN CONTACTO NOS ESCRIBIÓ ----------
// Clave para el reply-ratio: solo mandamos mensajes proactivos
// (recordatorios) a quienes YA nos escribieron.
export function registrarEntrante(telefono) {
  estado.contactosQueEscribieron.add(telefono);
}
export function puedeIniciarConversacion(telefono) {
  // Solo iniciamos con quien ya interactuó (evita señal de "extraño")
  return estado.contactosQueEscribieron.has(telefono);
}

// ---------- CONTROL DE VELOCIDAD ----------
function limpiarViejos() {
  const haceUnaHora = Date.now() - 3600000;
  const haceUnDia = Date.now() - 86400000;
  estado.enviados = estado.enviados.filter(t => t > haceUnDia);
  return {
    ultimaHora: estado.enviados.filter(t => t > haceUnaHora).length,
    ultimoDia: estado.enviados.length
  };
}

// ¿Podemos enviar ahora? (respeta límites de velocidad y pausas)
export function puedeEnviar() {
  if (Date.now() < estado.pausadoHasta) {
    return { ok: false, razon: 'auto-pausa por salud' };
  }
  const { ultimaHora, ultimoDia } = limpiarViejos();
  if (ultimaHora >= CONFIG.maxPorHora) return { ok: false, razon: 'límite/hora' };
  if (ultimoDia >= limiteHoy()) return { ok: false, razon: 'límite/día (warmup)' };
  return { ok: true };
}

export function registrarEnviado() {
  estado.enviados.push(Date.now());
}

// ---------- HEALTH MONITOR ----------
// Detecta señales de problema y auto-pausa antes del baneo.
export function reportarError(tipo) {
  if (tipo === '403' || tipo === 'forbidden') {
    estado.salud.errores403++;
    estado.salud.ultimoError = Date.now();
    // 403 es señal seria: pausa larga
    estado.pausadoHasta = Date.now() + 30 * 60000; // 30 min
    console.warn('🚨 Error 403 detectado. Auto-pausa 30 min para proteger el número.');
  }
  if (tipo === 'disconnect') {
    estado.salud.desconexiones++;
    // muchas desconexiones seguidas = pausa preventiva
    if (estado.salud.desconexiones % 3 === 0) {
      estado.pausadoHasta = Date.now() + 10 * 60000;
      console.warn('⚠️ Varias desconexiones. Auto-pausa 10 min.');
    }
  }
}

export function estadoSalud() {
  const { ultimaHora, ultimoDia } = limpiarViejos();
  const dias = estado.fechaInicio ? Math.floor((Date.now() - estado.fechaInicio) / 86400000) : 0;
  return {
    enWarmup: dias < CONFIG.warmupDias,
    diaDelNumero: dias,
    limiteHoy: limiteHoy(),
    enviadosHoy: ultimoDia,
    enviadosUltimaHora: ultimaHora,
    pausado: Date.now() < estado.pausadoHasta,
    pausaTerminaEn: estado.pausadoHasta > Date.now() ? Math.round((estado.pausadoHasta - Date.now()) / 60000) + ' min' : null,
    salud: estado.salud
  };
}

// ---------- SECUENCIA DE ESCRITURA HUMANA ----------
// Para textos largos, simula pausas de escritura naturales
// (el humano no escribe 40 palabras de un tirón sin pausas).
export async function simularEscritura(sock, jid, texto, sleep) {
  const delay = calcularDelay(texto);
  // Si el texto es largo, parte la animación de "escribiendo" en tramos
  // con micro-pausas, como alguien que piensa mientras escribe.
  const tramos = Math.max(1, Math.ceil(texto.length / 60));
  const porTramo = delay / tramos;
  for (let i = 0; i < tramos; i++) {
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(porTramo * (0.7 + Math.random() * 0.6)); // variación por tramo
    if (i < tramos - 1 && Math.random() < 0.3) {
      // a veces "pausa" (deja de escribir un momento), muy humano
      await sock.sendPresenceUpdate('paused', jid);
      await sleep(400 + Math.random() * 800);
    }
  }
  await sock.sendPresenceUpdate('paused', jid);
}
