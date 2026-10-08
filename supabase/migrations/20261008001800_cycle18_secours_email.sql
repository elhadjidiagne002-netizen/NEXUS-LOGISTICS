-- =====================================================================
-- NEXUS LOGISTICS — cycle 18 · Canal de secours e-mail (module 06, P2 « Canaux de secours »)
-- L'envoi est fait par NEXUS Market (/cron/notify-retry + functions/api/_lib/lg-fallback.js) :
-- WhatsApp d'abord avec le texte final (vars.texte), e-mail Brevo SEULEMENT si WhatsApp
-- échoue ou si le numéro manque. Côté base, il suffit que chaque message porte aussi
-- l'adresse e-mail du destinataire quand on la connaît :
--   · clients : déjà le cas (lg_notify : orders.buyer_email) ;
--   · vendeurs (relances de délai) : profiles.email (cycle 9, corrigé) ;
--   · gérant (rapport du soir) : nouveau réglage manager_email.
-- =====================================================================

create or replace function public.lg_evening_report(p_phone text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb; k jsonb;
begin
  v := public.lg_kpis((now() at time zone 'Africa/Dakar')::date, (now() at time zone 'Africa/Dakar')::date);
  k := v -> 'kpis';
  insert into public.notification_outbox (event_key, recipient, vars)
  values ('lg_evening_report', jsonb_strip_nulls(jsonb_build_object('phone', coalesce(p_phone, public.lg_cfg('manager_phone') #>> '{}'),
                                                                    'email', nullif(public.lg_cfg('manager_email') #>> '{}', ''))),
          (select x || jsonb_build_object('texte', public.lg_render_message('lg_evening_report', x)) from (select
          jsonb_build_object('livres', k -> 'delivered', 'echecs', k -> 'failed', 'premiere_presentation', k -> 'first_attempt_pct',
                             'ponctualite', k -> 'on_time_pct', 'especes', k -> 'cash_gap_fcfa', 'a_quai', k -> 'staged_over_24h') x) q));
  return v;
end; $$;

-- Suivi des envois par canal pour l'écran « Messages clients » (statuts écrits par NEXUS Market)
create or replace function public.lg_outbox_channels(p_days integer default 7) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['support']) then raise exception 'forbidden'; end if;
  return (select jsonb_build_object(
      'total', count(*),
      'whatsapp_sent', count(*) filter (where whatsapp_status = 'sent'),
      'email_fallback', count(*) filter (where email_status = 'sent'),
      'pending', count(*) filter (where status = 'pending'),
      'failed', count(*) filter (where status = 'failed'))
    from public.notification_outbox where event_key like 'lg\_%' and created_at > now() - make_interval(days => coalesce(p_days, 7)));
end; $$;

-- File d'envoi : statut e-mail en plus du statut WhatsApp
create or replace function public.lg_outbox_recent(p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['support']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', n.id, 'event_key', n.event_key, 'label', t.label, 'created_at', n.created_at,
      'to', regexp_replace(coalesce(n.recipient ->> 'phone', ''), '(\d{2})\d{3}(\d{2})$', '\1 *** \2'),
      'has_email', n.recipient ? 'email' and coalesce(n.recipient ->> 'email', '') <> '',
      'text', coalesce(n.vars ->> 'texte', public.lg_render_message(n.event_key, n.vars)),
      'status', n.status, 'whatsapp', n.whatsapp_status, 'email', n.email_status,
      'attempts', n.attempts, 'error', n.last_error) order by n.created_at desc), '[]')
    from (select * from public.notification_outbox where event_key like 'lg\_%' order by created_at desc limit least(coalesce(p_limit, 50), 200)) n
    left join public.lg_message_templates t on t.event_key = n.event_key);
end; $$;
