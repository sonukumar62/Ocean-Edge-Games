export async function recordAudit(client, actorId, event, subjectType = null, subjectId = null, details = {}) {
  await client.query(
    'insert into audit_logs(actor_id,event,subject_type,subject_id,details) values($1,$2,$3,$4,$5::jsonb)',
    [actorId, event, subjectType, subjectId, JSON.stringify(details)],
  );
}

export async function notifyAdmin(client, kind, title, body = '', href = null) {
  await client.query('insert into admin_notifications(kind,title,body,href) values($1,$2,$3,$4)', [kind, title, body, href]);
}
