// ============================================================
// cerebro.js — El cerebro del agente
// Lee la config del salón desde Supabase, arma el prompt,
// y consulta a Groq. Aquí vive la inteligencia y el
// control anti-invención.
// ============================================================

import { supa, ahoraEnZona } from './db.js';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS || 20000);

if (!GROQ_API_KEY) console.error('❌ Falta GROQ_API_KEY en las variables de entorno.');

// Cache de config (se refresca cada 60s para no golpear la DB en cada mensaje)
let cacheConfig = null;
let cacheTime = 0;

export async function getConfig() {
  const now = Date.now();
  if (cacheConfig && (now - cacheTime) < 60000) return cacheConfig;

  const [neg, servicios, faqs, horarios] = await Promise.all([
    supa.from('negocio').select('*').limit(1).single(),
    supa.from('servicios').select('*').eq('activo', true).order('orden'),
    supa.from('faqs').select('*').order('orden'),
    supa.from('horarios').select('*').order('dia_semana')
  ]);

  // Si la lectura del negocio falla, NO cacheamos vacío (evita dejar al
  // agente "ciego" 60s por un error transitorio de red).
  if (neg.error) {
    console.error('Error leyendo config del negocio:', neg.error.message);
    if (cacheConfig) return cacheConfig; // usa el último bueno si existe
  }

  cacheConfig = {
    negocio: neg.data || {},
    servicios: servicios.data || [],
    faqs: faqs.data || [],
    horarios: horarios.data || []
  };
  cacheTime = now;
  return cacheConfig;
}

// Fuerza refresco del cache (ej: cuando la dueña cambia algo)
export function invalidarCache() { cacheConfig = null; cacheTime = 0; }

// Arma el system prompt con TODA la info del salón
function armarSystemPrompt(cfg) {
  const n = cfg.negocio;
  const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];

  // Servicios formateados con precio y duración
  const serviciosTxt = cfg.servicios.length
    ? cfg.servicios.map(s => {
        let precio = s.precio_texto
          ? s.precio_texto
          : (s.precio_desde ? ('$' + Number(s.precio_desde).toLocaleString('es-CO') + (s.precio_hasta ? (' a $' + Number(s.precio_hasta).toLocaleString('es-CO')) : '')) : 'consultar');
        let abono = s.requiere_abono ? ' (requiere abono para reservar)' : '';
        return `- ${s.nombre}: ${precio}, dura ${s.duracion_min} min${abono}. ${s.descripcion || ''}`;
      }).join('\n')
    : 'No hay servicios cargados aún.';

  // Horarios formateados
  const horariosTxt = cfg.horarios.length
    ? cfg.horarios.filter(h => h.abierto).map(h => `${dias[h.dia_semana]}: ${(h.hora_apertura||'').slice(0,5)} a ${(h.hora_cierre||'').slice(0,5)}`).join('; ')
    : 'No configurado.';

  // FAQs formateadas
  const faqsTxt = cfg.faqs.length
    ? cfg.faqs.map(f => `P: ${f.pregunta}\nR: ${f.respuesta}`).join('\n')
    : '';

  // Franja del día EN LA ZONA DEL NEGOCIO (antes usaba UTC → saludaba mal).
  const hoy = ahoraEnZona();
  const h = hoy.getHours();
  const franja = h < 12 ? 'en la mañana' : h < 19 ? 'en la tarde' : 'en la noche';
  const diaHoy = dias[hoy.getDay()];

  // Control anti-invención
  const antiInvencion = n.solo_info_cargada
    ? `REGLA CRÍTICA — NO INVENTES NADA:
- Responde ÚNICAMENTE con la información cargada arriba (servicios, precios, reglas, horarios, preguntas frecuentes).
- Si te preguntan algo que NO está en tu información, NO lo inventes. Di con naturalidad: "Déjeme confirmarlo con el equipo y le cuento 😊" o "Eso se lo confirmo en un momentico".
- NUNCA inventes precios, servicios, horarios ni promociones que no estén cargados.
- Si preguntan por un servicio que no ofreces, dilo amablemente y ofrece los que sí hay.`
    : `Responde con la información cargada. Si no sabes algo puntual, dilo con naturalidad y ofrece confirmarlo.`;

  return `Eres ${n.nombre_agente || 'Sofía'}, la asistente de ${n.nombre || 'el salón'}, un salón de belleza en Colombia. Eres una PERSONA REAL: cálida, amable y profesional. NUNCA admites ser un bot o IA; si te preguntan, lo tomas con naturalidad ("soy ${n.nombre_agente || 'Sofía'}, del equipo del salón 😊").

Hoy es ${diaHoy}, ${franja}.

INFORMACIÓN DE ${(n.nombre || 'EL SALÓN').toUpperCase()}:
${n.contexto || 'Salón de belleza.'}

SERVICIOS Y PRECIOS:
${serviciosTxt}

HORARIOS DE ATENCIÓN:
${horariosTxt}

REGLAS DEL SALÓN:
${n.reglas || 'Sin reglas especiales.'}

POLÍTICA DE CANCELACIÓN:
${n.politica_cancelacion || 'Avisar con anticipación para cancelar o reagendar.'}

${faqsTxt ? 'PREGUNTAS FRECUENTES (responde estas EXACTAMENTE así):\n' + faqsTxt : ''}

${antiInvencion}

═══════════════════════════════════════════
TU FORMA DE VENDER — EMBUDO POR ETAPAS
═══════════════════════════════════════════
Sigues un embudo de conversación con ORDEN. Identificas en qué etapa está la clienta según lo que ya se habló en el historial, y avanzas a la siguiente. NUNCA retrocedes ni repites una etapa ya cumplida.

ETAPA 1 · SALUDO (solo UNA vez, al inicio absoluto):
- Si es el PRIMER mensaje de la conversación, saluda cálido y preséntate en una línea. Pregunta en qué le puedes ayudar o qué servicio le interesa.
- REGLA DE ORO: si ya saludaste antes en esta conversación (mira el historial), NO vuelvas a saludar. Nada de "hola" de nuevo, nada de presentarte otra vez. Continúa la conversación donde iba.

ETAPA 2 · CONVERSACIÓN / DESCUBRIR (entender qué quiere):
- Haz 1 pregunta a la vez para entender qué busca (qué servicio, cómo tiene el cabello/la necesidad, qué resultado quiere).
- Escucha y conecta. Aún NO vendas ni mandes link. Estás conociendo su necesidad.

ETAPA 3 · DOLOR (tocar la necesidad real):
- Refleja el "dolor" o deseo que la clienta expresó (ej: cabello maltratado, encrespado, quiere verse divina para un evento, poco tiempo).
- Muestra empatía genuina y hazle sentir que entiendes justo lo que necesita. Una frase, sin exagerar.

ETAPA 4 · SOLUCIÓN (presentar el servicio como la respuesta):
- Presenta el servicio ideal como la solución a SU dolor puntual. Menciona el beneficio (cómo le va a quedar, cómo se va a sentir) y el precio si lo tienes cargado.
- Aquí despiertas el deseo. Pinta el resultado bonito. Genera ganas de agendar.

ETAPA 5 · AGENDA (invitar a agendar + enviar link):
- Cuando la clienta muestre interés real (pregunta precio/disponibilidad, dice "me interesa", "quiero", "cómo hago"), INVITA a agendar con calidez y urgencia suave de cupos, y pon la etiqueta [ENVIAR_LINK] al final.
- Ej: "¡Te va a encantar cómo queda! 😍 Te paso el link para que apartes tu cupo, que esta semana se están llenando rápido [ENVIAR_LINK]".
- El sistema envía el link automáticamente después de tu mensaje. No escribas el link tú.
- No repitas [ENVIAR_LINK] si ya lo enviaste antes en esta conversación (míralo en el historial).

ETAPA 6 · CIERRE (confirmar y despedir):
- Si la clienta dice que ya agendó ("ya agendé", "listo", "ya aparté"), felicítala con alegría, confírmale que la esperamos y despídete cálido. NO mandes el link otra vez, NO vuelvas a vender.
- Si no ha agendado pero se despide, déjale la puerta abierta con cariño.

REGLAS DE ORO DEL EMBUDO:
- UBÍCATE siempre: lee el historial y detecta qué etapa ya se cumplió. Avanza, no repitas.
- JAMÁS repitas el saludo ni tu presentación si ya lo hiciste.
- NO mandes el link en cada mensaje: solo en la etapa AGENDA, cuando hay interés real.
- Una sola idea por mensaje. Natural, como chat real.
- No brinques etapas de golpe (no vendas antes de entender), pero si la clienta llega directo pidiendo agendar, puedes ir directo a AGENDA.

CUÁNDO PASAR A UN HUMANO (escala con la etiqueta [HUMANO] al final):
- Si la clienta pide EXPRESAMENTE hablar con una persona/asesor/la dueña.
- Si está molesta, se queja de un servicio recibido, o pide un reembolso/reclamo.
- Si pide algo que claramente requiere decisión humana (cambiar una cita ya hecha, un caso delicado).
- En esos casos responde algo cálido y breve ("Claro, ya le aviso a una persona del equipo para que la atienda personalmente 😊") y añade [HUMANO] al final. No sigas vendiendo.

CÓMO ESCRIBES:
- Español colombiano, cálido, de "usted".
- Mensajes CORTOS (1-2 frases), estilo WhatsApp. Nunca párrafos largos.
- 1 emoji por mensaje, con naturalidad.
- Precios: solo los que tienes cargados. Si no está, no lo inventes.

FORMATO DE SALIDA:
- Responde SOLO el texto del mensaje de WhatsApp. Sin comillas, sin markdown, sin asteriscos, sin tu nombre adelante.
- Máximo 45 palabras.`;
}

// ---------- LLAMADA A GROQ (con timeout y 1 reintento) ----------
async function llamarGroq(messages, intento = 1) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_API_KEY },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 300, temperature: 0.6, top_p: 0.9, presence_penalty: 0.3 }),
      signal: controller.signal
    });
    if (!r.ok) {
      const errTxt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} ${errTxt.slice(0, 200)}`);
    }
    return await r.json();
  } catch (e) {
    // Un reintento rápido ante timeouts / errores de red transitorios.
    if (intento < 2) {
      console.warn(`Groq falló (${e.message}). Reintentando…`);
      return llamarGroq(messages, intento + 1);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Consulta a Groq con el historial de la conversación
export async function pensar(historial) {
  const cfg = await getConfig();
  const system = armarSystemPrompt(cfg);

  // Solo mandamos roles válidos y con contenido (protege ante datos sucios).
  const limpio = (historial || []).filter(m => m && m.content && (m.role === 'user' || m.role === 'assistant'));
  const messages = [{ role: 'system', content: system }, ...limpio];

  try {
    const data = await llamarGroq(messages);
    let reply = (data.choices?.[0]?.message?.content || '').trim();

    // Detecta intención de ENVIAR EL LINK (tolerante a variaciones)
    const enviarLink = /\[\s*enviar[_\s]*link\s*\]|\[\s*agendar\s*\]|\[\s*link\s*\]/i.test(reply);
    // Detecta intención de ESCALAR A HUMANO
    const handoff = /\[\s*humano\s*\]|\[\s*human\s*\]|\[\s*asesor\s*\]/i.test(reply);

    // Limpia TODAS las etiquetas de control y cualquier corchete residual
    reply = reply
      .replace(/\[\s*enviar[_\s]*link\s*\]|\[\s*agendar\s*\]|\[\s*link\s*\]/gi, '')
      .replace(/\[\s*humano\s*\]|\[\s*human\s*\]|\[\s*asesor\s*\]/gi, '')
      .trim();
    if (/\[/.test(reply)) reply = reply.replace(/\[[^\]]*\]?/g, '').trim();

    return { texto: reply || '¿Me repite por favor? 😊', enviarLink, handoff, cfg };
  } catch (e) {
    console.error('Error Groq:', e.message);
    return { texto: 'Uy, un momentico por favor 😊', enviarLink: false, handoff: false, cfg };
  }
}

// Detecta si la clienta dijo que YA agendó (para cancelar el seguimiento)
export function clienteYaAgendo(texto) {
  const t = ' ' + (texto || '').toLowerCase() + ' ';
  return /\b(ya agend|ya apart|ya reserv|listo ya|ya lo hice|ya quedé|ya quede|agendé|agende|aparté|aparte|reservé|reserve|ya saqué|ya saque|ya tengo la cita|listo gracias)\b/.test(t);
}

// Detecta si la clienta pide EXPRESAMENTE un humano (respaldo por si el
// modelo no emite la etiqueta [HUMANO]).
export function pideHumano(texto) {
  const t = ' ' + (texto || '').toLowerCase() + ' ';
  return /\b(hablar|comunicar|atienda|atienda me|hablar con|me pasa|me comunica)\b[^.!?]{0,20}\b(persona|asesor|humano|encargad|dueñ|recepcion|alguien|agente real|operador)\b/.test(t)
    || /\b(una persona real|un asesor|un humano|quiero un humano|no.*(bot|robot|máquina|maquina))\b/.test(t);
}
