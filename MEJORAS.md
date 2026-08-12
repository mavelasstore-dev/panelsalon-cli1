# Mejoras del sistema — registro de cambios

Optimización integral del backend del agente (WhatsApp + Groq + Supabase).
Todos los cambios son **retrocompatibles**: mismas variables de entorno
existentes, mismo esquema + columnas nuevas opcionales.

## 🔴 Bugs críticos corregidos

1. **`/reset-sesion` estaba roto.** Usaba la variable `forzarLimpiezaSesion`
   sin declararla → en un módulo ES (strict mode) lanzaba `ReferenceError` y
   el endpoint siempre fallaba. Ahora está declarada y, además, se **respeta**
   en el bucle de reconexión (evita que la sesión vieja "reviva" durante el reset).

2. **Zona horaria incorrecta.** El saludo ("buenos días/tardes/noches") y las
   fechas usaban la hora **UTC** del servidor, no la de Colombia → saludaba mal
   por ~5 horas y las fechas de recordatorio podían quedar corridas. Se
   centralizó en `ahoraEnZona()` / `fechaISOZona()` con `TZ_NEGOCIO`
   (default `America/Bogota`).

3. **Respuestas dobles / solapadas.** Si la clienta mandaba varios mensajes
   seguidos, el agente llamaba a Groq una vez por mensaje y respondía varias
   veces, sin orden. Ahora hay:
   - **Dedup por ID de mensaje** (WhatsApp re-entrega al reconectar).
   - **Debounce + lock por contacto**: agrupa mensajes rápidos y responde
     **una sola vez** con todo el contexto (`DEBOUNCE_MS`, default 3.5s).

4. **Groq sin timeout.** Un `fetch` colgado dejaba el mensaje atascado para
   siempre. Ahora hay **timeout (`GROQ_TIMEOUT_MS`, 20s) + 1 reintento** y
   manejo de errores HTTP.

5. **Baileys con vulnerabilidad zero-day** (6.7.9, advisory GHSA-qvv5-jq5g-4cgg,
   spoofing de mensajes). Actualizado a **6.7.24** y corregido el `import`
   (la API cambió a exports con nombre; el patrón viejo dejaba todo `undefined`).

## 🟠 Robustez y seguridad

6. **Endpoints sensibles protegidos.** `/reset-sesion`, `/desvincular`,
   `/refrescar-config`, `/pausar`, `/reanudar` aceptan un token opcional
   (`ADMIN_TOKEN`, en header `X-Admin-Token` o `?token=`). Si no se define,
   siguen abiertos (retrocompatible).

7. **Handlers globales de error** (`unhandledRejection`, `uncaughtException`):
   un fallo puntual ya no tumba el proceso.

8. **Warmup anti-ban persistente.** Antes se reiniciaba en cada deploy (un
   número viejo se trataba como nuevo). Ahora la fecha de "nacimiento" del
   número se guarda en el volumen (`antiban.json`).

9. **Límites anti-ban configurables** por entorno (`ANTIBAN_*`).

## 🟢 Inteligencia y funciones nuevas

10. **Handoff humano.** El agente detecta cuando la clienta pide una persona,
    se queja o el caso es delicado (etiqueta `[HUMANO]` del modelo + respaldo
    por regex `pideHumano`). Al escalar: **pausa el agente en ese chat** (2h,
    configurable), y **avisa a la dueña** por WhatsApp si se configura
    `NUMERO_DUENO`. La dueña también puede pausar/reanudar desde el panel
    (`/pausar`, `/reanudar`) o global (`negocio.pausado_global`).

11. **Manejo de audios/imágenes/stickers.** Antes: silencio total. Ahora
    responde cortésmente pidiendo texto (con cooldown de 90s para no repetir).

12. **Prompt mejorado**: incluye el día actual, evita repetir `[ENVIAR_LINK]`,
    y añade el criterio de escalar a humano. Filtra roles inválidos del historial.

13. **Zona horaria correcta en el cálculo de horarios disponibles** y en el
    cron de recordatorios.

## Migración de base de datos

Corre **una vez** en Supabase → SQL Editor:

```
migracion_v3.sql
```

Agrega (sin borrar nada): `clientes.pausado`, `clientes.pausado_hasta`,
`negocio.pausado_global`, `negocio.handoff_minutos`.

## Variables de entorno nuevas (todas opcionales)

Ver `.env.example`. Resumen: `TZ_NEGOCIO`, `ADMIN_TOKEN`, `NUMERO_DUENO`,
`GROQ_MODEL`, `GROQ_TIMEOUT_MS`, `DEBOUNCE_MS`, `ANTIBAN_*`.

## Nota sobre recordatorios (importante)

El agente agenda por **link externo** (AgendaPro), así que la tabla `citas`
del sistema **no se llena sola** desde el chat. Por eso el cron de
recordatorios sólo enviará avisos de citas que existan en `citas` (creadas
manualmente o por una futura integración). Si quieres recordatorios
automáticos de las citas de AgendaPro, hay que **sincronizar** AgendaPro →
tabla `citas` (webhook o import). Queda documentado como siguiente paso.
