import type { PaletteColor, SymmetrySettings } from '../../model/types.ts';
import type { RugRow, SyncTransport } from '../protocol.ts';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  ownerId: string;
}

export async function createSupabaseTransport(config: SupabaseConfig): Promise<SyncTransport> {
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(config.url, config.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return {
    async upsert(row) {
      const { error } = await client.from('rugs').upsert(toRow(row), { onConflict: 'id' });
      if (error) throw new Error(error.code === '42501' ? 'forbidden' : 'network');
    },
    async get(projectId) {
      const { data, error } = await client.from('rugs').select('*').eq('id', projectId).maybeSingle();
      if (error) throw new Error(error.message === 'JWT expired' ? 'auth' : 'network');
      return data ? fromRow(data) : null;
    },
    async list() {
      const { data, error } = await client.from('rugs').select('*').order('updated_at', { ascending: false });
      if (error) throw new Error(error.message === 'JWT expired' ? 'auth' : 'network');
      return (data ?? []).map(fromRow);
    },
  };
}

export async function signIn(config: SupabaseConfig, email: string, password: string): Promise<string | null> {
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(config.url, config.anonKey);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) return null;
  return data.user.id;
}

function toRow(row: RugRow): Record<string, unknown> {
  return {
    id: row.id,
    owner_id: row.ownerId,
    name: row.name,
    width: row.width,
    height: row.height,
    schema_version: row.schemaVersion,
    document_revision: row.documentRevision,
    updated_at: row.updatedAt,
    palette: row.palette,
    cells: row.cells,
    grid_visible: row.gridVisible,
    checker_visible: row.checkerVisible,
    checker_block: row.checkerBlock,
    symmetry: row.symmetry,
    content_hash: row.contentHash,
  };
}

function fromRow(row: Record<string, unknown>): RugRow {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    name: String(row.name),
    width: Number(row.width),
    height: Number(row.height),
    schemaVersion: Number(row.schema_version),
    documentRevision: Number(row.document_revision),
    updatedAt: String(row.updated_at),
    palette: Array.isArray(row.palette) ? row.palette as PaletteColor[] : [],
    cells: String(row.cells),
    gridVisible: Boolean(row.grid_visible),
    checkerVisible: Boolean(row.checker_visible),
    checkerBlock: Number(row.checker_block),
    symmetry: row.symmetry as SymmetrySettings,
    contentHash: String(row.content_hash),
  };
}
