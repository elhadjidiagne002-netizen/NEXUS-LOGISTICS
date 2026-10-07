-- =====================================================================
-- NEXUS LOGISTICS — cycle 2 · modèles de messages et file d'envoi (module 06, annexe B)
-- =====================================================================

create or replace function public.lg_templates_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['support']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'event_key', t.event_key, 'label', t.label, 'body_fr', t.body_fr, 'body_wo', t.body_wo, 'active', t.active,
      'updated_at', t.updated_at,
      'sent_7d', (select count(*) from public.notification_outbox n where n.event_key = t.event_key and n.created_at > now() - interval '7 days'),
      -- dernières variables réellement envoyées : servent d'exemple pour l'aperçu
      'sample', coalesce((select n.vars - 'texte' from public.notification_outbox n where n.event_key = t.event_key order by n.created_at desc limit 1),
                         '{"prenom":"Awa","commande":"A7F3C2D1","vendeur":"Boutique Ndèye","montant":12500,"lien":"https://logistics.nexusmarket.sn/suivi/…","livreur":"Moussa","heure":"14h30","code":"4812","minutes":10,"motif":"client absent","produit":"Huile 1 L","facture":"FAC-2026-000001","colis":2}'::jsonb)
    ) order by t.position), '[]') from public.lg_message_templates t);
end; $$;

create or replace function public.lg_template_save(p_event text, p_body_fr text, p_active boolean default true, p_body_wo text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['support']) then raise exception 'forbidden'; end if;
  if length(trim(coalesce(p_body_fr, ''))) < 10 then raise exception 'message_too_short'; end if;
  if length(p_body_fr) > 1000 then raise exception 'message_too_long'; end if;
  update public.lg_message_templates set body_fr = trim(p_body_fr), body_wo = nullif(trim(p_body_wo), ''), active = coalesce(p_active, true),
         updated_by = auth.uid(), updated_at = now() where event_key = p_event;
  if not found then raise exception 'unknown_template'; end if;
  perform public.lg_audit('template_save', 'template', p_event, jsonb_build_object('active', p_active));
  return jsonb_build_object('ok', true);
end; $$;

create or replace function public.lg_preview_message(p_event text, p_body text, p_vars jsonb) returns text
language sql stable security definer set search_path = public as $$
  select public.lg_render_message(p_event, p_vars, p_body)
$$;

-- File d'envoi : derniers messages logistiques, numéro masqué (données personnelles)
create or replace function public.lg_outbox_recent(p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['support']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', n.id, 'event_key', n.event_key, 'label', t.label, 'created_at', n.created_at,
      'to', regexp_replace(coalesce(n.recipient ->> 'phone', ''), '(\d{2})\d{3}(\d{2})$', '\1 *** \2'),
      'text', coalesce(n.vars ->> 'texte', public.lg_render_message(n.event_key, n.vars)),
      'status', n.status, 'whatsapp', n.whatsapp_status, 'attempts', n.attempts, 'error', n.last_error) order by n.created_at desc), '[]')
    from (select * from public.notification_outbox where event_key like 'lg\_%' order by created_at desc limit least(coalesce(p_limit, 50), 200)) n
    left join public.lg_message_templates t on t.event_key = n.event_key);
end; $$;
