// ============================================================
// db.js — Conexión a Supabase y funciones de datos
// ============================================================

import { createClient } from '@supabase/supabase-js';

export const supa = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service key en el backend (más permisos que la anon)
);

let NEGOCIO_ID = null;
export async function getNegocioId() {
  if (NEGOCIO_ID) return NEGOCIO_ID;
  const { data } = await supa.from('negocio').select('id').limit(1).single();
  NEGOCIO_ID = data?.id;
  return NEGOCIO_ID;
}

// ---------- CONVERSACIONES ----------
export async function guardarMensaje(telefono, nombre, rol, mensaje) {
  const negocio_id = await getNegocioId();
  await supa.from('conversaciones').insert({
    negocio_id, cliente_telefono: telefono, cliente_nombre: nombre, rol, mensaje
  });
}

// Trae el historial reciente de un cliente (para dar contexto al agente)
export async function getHistorial(telefono, limite = 12) {
  const { data } = await supa.from('conversaciones')
    .select('rol, mensaje')
    .eq('cliente_telefono', telefono)
    .order('created_at', { ascending: false })
    .limit(limite);
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

// ---------- HORARIOS DISPONIBLES ----------
// Calcula los espacios libres de los próximos días, según horario del salón
// y citas ya ocupadas. Esto es lo que se le ofrece al cliente para agendar.
export async function calcularHorariosDisponibles(diasAdelante = 3, duracionMin = 60) {
  const negocio_id = await getNegocioId();
  const { data: horarios } = await supa.from('horarios').select('*').eq('negocio_id', negocio_id);
  const hMap = {};
  (horarios || []).forEach(h => { hMap[h.dia_semana] = h; });

  const hoy = new Date();
  const resultado = [];

  for (let d = 0; d < diasAdelante + 2 && resultado.length < 2; d++) {
    const fecha = new Date(hoy);
    fecha.setDate(hoy.getDate() + d);
    const dow = fecha.getDay();
    const horario = hMap[dow];
    if (!horario || !horario.abierto) continue;

    const fechaStr = fecha.toISOString().slice(0, 10);
    // citas ya agendadas ese día
    const { data: citas } = await supa.from('citas')
      .select('hora, duracion_min')
      .eq('negocio_id', negocio_id).eq('fecha', fechaStr)
      .neq('estado', 'cancelada');
    const ocupadas = new Set((citas || []).map(c => c.hora.slice(0, 5)));

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
      if (mins >= ahoraMin && !ocupadas.has(hora)) {
        slots.push(hora);
      }
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
    // actualiza la última visita del cliente
    await supa.from('clientes').update({ ultima_visita: fecha }).eq('telefono', telefono);
  }
  return { ok: !error, cita: data, error };
}

// ---------- CITAS PARA RECORDATORIO ----------
// Trae las citas de mañana que aún no tienen recordatorio enviado
export async function citasParaRecordar() {
  const negocio_id = await getNegocioId();
  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  const fechaStr = manana.toISOString().slice(0, 10);
  const { data } = await supa.from('citas')
    .select('*')
    .eq('negocio_id', negocio_id)
    .eq('fecha', fechaStr)
    .eq('recordatorio_enviado', false)
    .in('estado', ['agendada', 'confirmada']);
  return data || [];
}

export async function marcarRecordatorioEnviado(citaId) {
  await supa.from('citas').update({ recordatorio_enviado: true }).eq('id', citaId);
}
