import type { PaletteColor } from '../../model/types.ts';
import type { RugRef, RugRow, SyncTransport } from '../protocol.ts';
import { packSymmetry, unpackSymmetry } from '../restore.ts';

export interface SupabaseConfig {
  url: string;
  publishableKey: string;
  ownerId: string;
}

export interface SignedInUser {
  id: string;
  email: string;
}

let clientKey = '';
let clientPromise: Promise<import('@supabase/supabase-js').SupabaseClient> | null = null;

async function clientFor(config: { url: string; publishableKey: string }) {
  assertPublishable(config.publishableKey);
  const key = `${config.url}\n${config.publishableKey}`;
  if (!clientPromise || clientKey !== key) {
    clientKey = key;
    const { createClient } = await import('@supabase/supabase-js');
    clientPromise = Promise.resolve(createClient(config.url, config.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    }));
  }
  return clientPromise;
}

export async function createSupabaseTransport(config: SupabaseConfig): Promise<SyncTransport> {
  const client = await clientFor(config);
  return {
    async upsert(row) {
      const { error } = await client.from('rugs').upsert(toRow(row), { onConflict: 'id' });
      if (error) throw new Error(error.code === '42501' ? 'forbidden' : 'network');
    },
    async head(projectId) {
      const { data, error } = await client.from('rugs').select('document_revision, updated_at').eq('id', projectId).maybeSingle();
      if (error) throw new Error(error.message === 'JWT expired' ? 'auth' : 'network');
      if (!data) return null;
      return { documentRevision: Number(data.document_revision), updatedAt: String(data.updated_at) };
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
    async listRefs() {
      const { data, error } = await client.from('rugs').select('id, name, width, height, document_revision, updated_at').order('updated_at', { ascending: false });
      if (error) throw new Error(error.message === 'JWT expired' ? 'auth' : 'network');
      return (data ?? []).map(refFromRow);
    },
    async remove(projectId) {
      const { error } = await client.from('rugs').delete().eq('id', projectId);
      if (error) throw new Error(error.code === '42501' ? 'forbidden' : 'network');
    },
  };
}

export async function signIn(config: SupabaseConfig, email: string, password: string): Promise<SignedInUser | null> {
  if (config.publishableKey.startsWith('sb_secret_')) return null;
  const client = await clientFor(config);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? email };
}

export async function currentSession(config: { url: string; publishableKey: string }): Promise<SignedInUser | null> {
  if (config.publishableKey.startsWith('sb_secret_')) return null;
  const client = await clientFor(config);
  const { data } = await client.auth.getSession();
  const user = data.session?.user;
  if (!user) return null;
  return { id: user.id, email: user.email ?? '' };
}

export async function signOut(config: { url: string; publishableKey: string }): Promise<void> {
  if (config.publishableKey.startsWith('sb_secret_')) return;
  const client = await clientFor(config);
  await client.auth.signOut();
}

function assertPublishable(key: string): void {
  if (key.startsWith('sb_secret_')) throw new Error('forbidden');
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
    symmetry: packSymmetry(row.symmetry, row.traces ?? []),
    content_hash: row.contentHash,
  };
}

function refFromRow(row: Record<string, unknown>): RugRef {
  return {
    id: String(row.id),
    name: String(row.name),
    width: Number(row.width),
    height: Number(row.height),
    documentRevision: Number(row.document_revision),
    updatedAt: String(row.updated_at),
  };
}

function fromRow(row: Record<string, unknown>): RugRow {
  const packed = unpackSymmetry(row.symmetry);
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
    symmetry: packed.symmetry,
    contentHash: String(row.content_hash),
    traces: packed.traces,
  };
}
