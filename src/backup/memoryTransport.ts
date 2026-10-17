import type { RugRow, SyncTransport } from './protocol.ts';

export class MemoryTransport implements SyncTransport {
  rows = new Map<string, RugRow>();
  failUpsert = false;
  authExpired = false;
  actorId = 'owner-1';

  async upsert(row: RugRow): Promise<void> {
    if (this.actorId !== row.ownerId) throw new Error('forbidden');
    if (this.authExpired) throw new Error('auth');
    if (this.failUpsert) throw new Error('network');
    this.rows.set(row.id, row);
  }

  async get(projectId: string): Promise<RugRow | null> {
    if (this.authExpired) throw new Error('auth');
    const row = this.rows.get(projectId);
    if (!row || row.ownerId !== this.actorId) return null;
    return row;
  }

  async list(): Promise<RugRow[]> {
    if (this.authExpired) throw new Error('auth');
    return [...this.rows.values()].filter((row) => row.ownerId === this.actorId);
  }

  async listRefs() {
    return (await this.list()).map((row) => ({
      id: row.id,
      name: row.name,
      width: row.width,
      height: row.height,
      documentRevision: row.documentRevision,
      updatedAt: row.updatedAt,
    }));
  }

  async remove(projectId: string): Promise<void> {
    if (this.authExpired) throw new Error('auth');
    const row = this.rows.get(projectId);
    if (row && row.ownerId !== this.actorId) throw new Error('forbidden');
    this.rows.delete(projectId);
  }
}
