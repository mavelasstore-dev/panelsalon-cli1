-- ============================================================
-- ACTUALIZACIÓN: sistema de agendación por LINK
-- Corre esto en Supabase → SQL Editor (no borra nada, solo agrega)
-- ============================================================

alter table negocio add column if not exists link_agendamiento text;
alter table negocio add column if not exists seguimiento_activo boolean default true;
alter table negocio add column if not exists seguimiento_minutos int default 8;
alter table negocio add column if not exists mensaje_cupos text;

-- Precargar el link de Divinas Salon (opcional, la doctora puede cambiarlo en el panel)
update negocio set link_agendamiento = 'https://agendapro.com/site/co/divinas'
where link_agendamiento is null;
