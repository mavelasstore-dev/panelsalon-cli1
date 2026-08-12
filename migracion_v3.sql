-- ============================================================
-- MIGRACIÓN v3 — Handoff humano + pausa del agente
-- Corre esto en Supabase → SQL Editor. NO borra nada: solo agrega columnas.
-- Es seguro ejecutarlo aunque ya lo hayas corrido (usa IF NOT EXISTS).
-- ============================================================

-- Pausa del agente por CLIENTE (cuando un humano toma el chat).
alter table clientes add column if not exists pausado boolean default false;
alter table clientes add column if not exists pausado_hasta timestamptz;

-- Pausa GLOBAL del agente (interruptor general desde el panel).
alter table negocio add column if not exists pausado_global boolean default false;

-- Cuántos minutos se pausa el agente en un chat tras un handoff (default 2h).
alter table negocio add column if not exists handoff_minutos int default 120;

-- Índice para consultar rápido los chats pausados.
create index if not exists idx_clientes_pausado on clientes(pausado) where pausado = true;
