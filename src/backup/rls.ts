/** Pure stand-in for the SQL policies in supabase/migrations/001_backups.sql. */
export function canReadBackup(actor: { role: 'anon' | 'authenticated'; userId: string | null }, ownerId: string): boolean {
  return actor.role === 'authenticated' && actor.userId !== null && actor.userId === ownerId;
}

export function canWriteBackup(actor: { role: 'anon' | 'authenticated'; userId: string | null }, ownerId: string): boolean {
  return canReadBackup(actor, ownerId);
}
