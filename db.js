// ============================================================
// db.js — Conexión a Supabase y funciones de datos
// ============================================================

import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en las variables de entorno.');
}

export const supa = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service key en el backend (más permisos que la anon)
);

// Zona horaria del negocio (configurable). Colombia no tiene horario de verano,
// así que estas conversiones son estables todo el año.
export const TZ = process.env.TZ_NEGOCIO || 'America/Bogota';

// ---------- UTILIDADES DE ZONA HORARIA ----------
// El servidor (Railway) suele correr en UTC. Estas funciones devuelven la
// hora/fecha REAL del negocio para que saludos, franjas y fechas no fallen.
export function ahoraEnZona(tz = TZ) {
  // Devuelve un Date cuyos campos locales (getHours, etc.) equivalen a la
  // hora de pared en la zona indicada.
  return new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
}

export function fechaISOZona(d = new Date(), tz = TZ) {
  // YYYY-MM-DD según la zona del negocio (en-CA formatea ISO).
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

// ---------- ID DEL NEGOCIO (single-tenant por deploy) ----------
let NEGOCIO_ID = null;
export async function getNegocioId() {
  if (NEGOCIO_ID) return NEGOCIO_ID;
  const { data, error } = await supa.from('negocio').select('id').limit(1).single();
  if (error) { console.error('Error leyendo negocio_id:', error.message); return null; }
  NEGOCIO_ID = data?.id;
  return NEGOCIO_ID;
}

// ---------- CONVERSACIONES ----------
export async function guardarMensaje(telefono, nombre, rol, mensaje, atendidoPor = 'agente') {
  const negocio_id = await getNegocioId();
  const { error } = await supa.from('conversaciones').insert({
    negocio_id, cliente_telefono: telefono, cliente_nombre: nombre, rol, mensaje,
    atendido_por: atendidoPor
  });
  if (error) console.error('Error guardando mensaje:', error.message);
}

// Trae el historial reciente de un cliente (para dar contexto al agente).
// Filtra por negocio_id además del teléfono (correcto y a prueba de futuro).
export async function getHistorial(telefono, limite = 12) {
  const negocio_id = await getNegocioId();
  const { data, error } = await supa.from('conversaciones')
    .select('rol, mensaje, created_at')
    .eq('negocio_id', negocio_id)
    .eq('cliente_telefono', telefono)
    .order('created_at', { ascending: false })
    .limit(limite);
  if (error) { console.error('Error leyendo historial:', error.message); return []; }
  return (data || []).reverse().map(m => ({ role: m.rol, content: m.mensaje }));
}

// ---------- CLIENTES ----------
export async function upsertCliente(telefono, nombre) {
  const negocio_id = await getNegocioId();
  const { data: existe } = await supa.from('clientes').select('id').eq('telefono', telefono).maybeSingle();
  if (!existe) {
    await supa.from('clientes').insert({ negocio_id, telefono, nombre });
  } else if (nombre) {
    await supa.from('clientes').update({ nombre }).eq('telefono', telefono);
  }
}

// ---------- HANDOFF / PAUSA POR CLIENTE ----------
// Permite que un humano (la dueña) tome el control de un chat y el agente
// se calle. Se apoya en columnas opcionales (ver migracion_v3.sql). Si esas
// columnas no existen todavía, el sistema degrada con gracia (nunca pausa).
export async function getPausaCliente(telefono) {
  const { data, error } = await supa.from('clientes')
    .select('pausado, pausado_hasta')
    .eq('telefono', telefono).maybeSingle();
  if (error || !data) return { pausado: false };
  // pausa temporal: si venció, se considera activo de nuevo
  if (data.pausado_hasta && new Date(data.pausado_hasta) < new Date()) {
    return { pausado: false };
  }
  return { pausado: !!data.pausado, pausado_hasta: data.pausado_hasta || null };
}

export async function setPausaCliente(telefono, pausado, minutos = null) {
  const update = { pausado };
  if (pausado && minutos) update.pausado_hasta = new Date(Date.now() + minutos * 60000).toISOString();
  if (!pausado) update.pausado_hasta = null;
  const { error } = await supa.from('clientes').update(update).eq('telefono', telefono);
  if (error) console.error('Error actualizando pausa cliente:', error.message);
  return !error;
}

// ---------- HORARIOS DISPONIBLES ----------
// Calcula los espacios libres de los próximos días, según horario del salón
// y citas ya ocupadas. (Modo agenda en-chat opcional; corregido a zona horaria.)
export async function calcularHorariosDisponibles(diasAdelante = 3, duracionMin = 60) {
  const negocio_id = await getNegocioId();
  const { data: horarios } = await supa.from('horarios').select('*').eq('negocio_id', negocio_id);
  const hMap = {};
  (horarios || []).forEach(h => { hMap[h.dia_semana] = h; });

  const hoy = ahoraEnZona();               // hora real del negocio
  const resultado = [];

  for (let d = 0; d < diasAdelante + 2 && resultado.length < 2; d++) {
    const fecha = new Date(hoy);
    fecha.setDate(hoy.getDate() + d);
    const dow = fecha.getDay();
    const horario = hMap[dow];
    if (!horario || !horario.abierto) continue;

    const fechaStr = fechaISOZona(fecha);
    // citas ya agendadas ese día
    const { data: citas } = await supa.from('citas')
      .select('hora, duracion_min')
      .eq('negocio_id', negocio_id).eq('fecha', fechaStr)
      .neq('estado', 'cancelada');
    const ocupadas = new Set((citas || []).map(c => (c.hora || '').slice(0, 5)));

    // genera slots cada 30 min dentro del horario
    const [ah, am] = (horario.hora_apertura || '09:00').split(':').map(Number);
    const [ch, cm] = (horario.hora_cierre || '19:00').split(':').map(Number);
    const slots = [];
    let mins = ah * 60 + am;
    const fin = ch * 60 + cm;
    const ahoraMin = (d === 0) ? (hoy.getHours() * 60 + hoy.getMinutes() + 60) : 0; // hoy: mínimo 1h de anticipación

    while (mins + duracionMin <= fin) {
      const hh = Math.floor(mins / 60), mm = mins % 60;
      const hora = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      if (mins >= ahoraMin && !ocupadas.has(hora)) slots.push(hora);
      mins += 30;
    }

    if (slots.length) {
      const etiqueta = d === 0 ? 'Hoy' : d === 1 ? 'Mañana' : fecha.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric' });
      resultado.push({ fecha: fechaStr, etiqueta, slots: slots.slice(0, 6) });
    }
  }
  return resultado;
}

// ---------- AGENDAR CITA ----------
export async function agendarCita({ telefono, nombre, servicioNombre, fecha, hora, duracionMin }) {
  const negocio_id = await getNegocioId();
  const { data, error } = await supa.from('citas').insert({
    negocio_id,
    cliente_nombre: nombre,
    cliente_telefono: telefono,
    servicio_nombre: servicioNombre,
    fecha, hora,
    duracion_min: duracionMin || 60,
    estado: 'agendada',
    creada_por: 'agente'
  }).select().single();

  if (!error) {
    await supa.from('clientes').update({ ultima_visita: fecha }).eq('telefono', telefono);
  }
  return { ok: !error, cita: data, error };
}

// ---------- CITAS PARA RECORDATORIO ----------
// Trae las citas de mañana (zona del negocio) sin recordatorio enviado.
export async function citasParaRecordar() {
  const negocio_id = await getNegocioId();
  const manana = new Date(Date.now() + 24 * 3600 * 1000);
  const fechaStr = fechaISOZona(manana);
  const { data, error } = await supa.from('citas')
    .select('*')
    .eq('negocio_id', negocio_id)
    .eq('fecha', fechaStr)
    .eq('recordatorio_enviado', false)
    .in('estado', ['agendada', 'confirmada']);
  if (error) { console.error('Error leyendo citas para recordar:', error.message); return []; }
  return data || [];
}

export async function marcarRecordatorioEnviado(citaId) {
  await supa.from('citas').update({ recordatorio_enviado: true }).eq('id', citaId);
}
