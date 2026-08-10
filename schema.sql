-- ============================================================
-- KARL ENGINE · Salón de Belleza — Esquema de base de datos
-- Para Supabase (PostgreSQL). Ejecuta esto en el SQL Editor.
-- ============================================================

-- ---------- 1. CONFIGURACIÓN DEL NEGOCIO ----------
-- Toda la info que la dueña carga para que el agente sepa responder.
create table if not exists negocio (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  tipo text default 'Salón de belleza',
  telefono text,
  direccion text,
  ciudad text,
  -- Contexto libre: la dueña escribe todo lo que el agente debe saber
  contexto text,                       -- "Somos un salón familiar, especializados en color..."
  reglas text,                         -- "No atendemos sin cita. Abono del 20% para servicios largos..."
  politica_cancelacion text,           -- "Cancelar con 24h de anticipación..."
  tono_agente text default 'cálido',   -- cómo debe hablar el agente
  nombre_agente text default 'Sofía',  -- nombre de la asistente virtual
  mensaje_bienvenida text,             -- saludo inicial personalizado
  -- Control anti-invención
  solo_info_cargada boolean default true,  -- si true, el agente NO inventa nada fuera de lo cargado
  updated_at timestamptz default now()
);

-- ---------- 2. SERVICIOS ----------
-- Cada servicio con su precio, duración y descripción.
create table if not exists servicios (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid references negocio(id) on delete cascade,
  nombre text not null,                -- "Keratina", "Manicure semipermanente"
  descripcion text,                    -- qué incluye
  precio_desde numeric,                -- precio o "desde"
  precio_hasta numeric,                -- opcional, si es rango
  precio_texto text,                   -- alternativa: "Desde $80.000" o "Según largo del cabello"
  duracion_min int default 60,         -- cuánto dura (para la agenda)
  requiere_abono boolean default false,
  abono_porcentaje int default 0,
  activo boolean default true,
  orden int default 0
);

-- ---------- 3. HORARIOS DE ATENCIÓN ----------
create table if not exists horarios (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid references negocio(id) on delete cascade,
  dia_semana int not null,             -- 0=domingo ... 6=sábado
  abierto boolean default true,
  hora_apertura time default '09:00',
  hora_cierre time default '19:00'
);

-- ---------- 4. CITAS / AGENDA ----------
create table if not exists citas (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid references negocio(id) on delete cascade,
  cliente_nombre text,
  cliente_telefono text,
  servicio_id uuid references servicios(id),
  servicio_nombre text,                -- copia por si se borra el servicio
  fecha date not null,
  hora time not null,
  duracion_min int default 60,
  estado text default 'agendada',      -- agendada, confirmada, completada, cancelada, no_asistio
  abono_pagado boolean default false,
  notas text,
  recordatorio_enviado boolean default false,
  creada_por text default 'agente',    -- agente | manual
  created_at timestamptz default now()
);

-- ---------- 5. CLIENTES (para reactivación) ----------
create table if not exists clientes (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid references negocio(id) on delete cascade,
  nombre text,
  telefono text unique,
  ultima_visita date,
  total_citas int default 0,
  notas text,
  created_at timestamptz default now()
);

-- ---------- 6. CONVERSACIONES (historial de WhatsApp) ----------
create table if not exists conversaciones (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid references negocio(id) on delete cascade,
  cliente_telefono text not null,
  cliente_nombre text,
  rol text not null,                   -- 'user' | 'assistant'
  mensaje text not null,
  atendido_por text default 'agente',  -- agente | humano
  created_at timestamptz default now()
);

-- ---------- 7. PREGUNTAS FRECUENTES ----------
-- La dueña carga FAQs para que el agente responda exacto y no invente.
create table if not exists faqs (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid references negocio(id) on delete cascade,
  pregunta text not null,
  respuesta text not null,
  orden int default 0
);

-- ---------- ÍNDICES ----------
create index if not exists idx_citas_fecha on citas(negocio_id, fecha);
create index if not exists idx_conv_tel on conversaciones(negocio_id, cliente_telefono, created_at);
create index if not exists idx_serv_negocio on servicios(negocio_id, activo);

-- ---------- DATOS INICIALES DE EJEMPLO ----------
-- (La dueña los reemplaza desde el panel)
insert into negocio (nombre, tipo, contexto, reglas, nombre_agente, mensaje_bienvenida)
values (
  'Mi Salón',
  'Salón de belleza',
  'Somos un salón de belleza. Complete este contexto desde el panel con la información real de su negocio.',
  'Complete las reglas de su salón desde el panel.',
  'Sofía',
  '¡Hola! 😊 Bienvenida a nuestro salón. ¿En qué le puedo ayudar hoy?'
)
on conflict do nothing;

-- ============================================================
-- Campos para el sistema de agendación por LINK (v2)
-- ============================================================
alter table negocio add column if not exists link_agendamiento text;
alter table negocio add column if not exists seguimiento_activo boolean default true;
alter table negocio add column if not exists seguimiento_minutos int default 8;
alter table negocio add column if not exists mensaje_cupos text;
