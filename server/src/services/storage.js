import { createClient } from '@supabase/supabase-js';

let client;
let bucketReady=false;
function storageClient() {
  if (client) return client;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    const error = new Error('Profile asset storage is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY on the server.');
    error.status = 503;
    error.code = 'STORAGE_NOT_CONFIGURED';
    throw error;
  }
  client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return client;
}

const bucketName = () => process.env.SUPABASE_STORAGE_BUCKET || 'oeg-profile-assets';

export async function ensurePrivateBucket() {
  if(bucketReady)return;
  const storage = storageClient().storage;
  const name = bucketName();
  const existing = await storage.getBucket(name);
  if (existing.data) {
    if (existing.data.public) throw new Error(`Storage bucket ${name} must be private.`);
    bucketReady=true;
    return;
  }
  const created = await storage.createBucket(name, { public: false, allowedMimeTypes: ['image/png','image/jpeg','image/webp'], fileSizeLimit: '4MB' });
  if (created.error && !String(created.error.message).toLowerCase().includes('already exists')) throw new Error('Could not create the private Supabase profile asset bucket.');
  bucketReady=true;
}

export async function uploadProfileAsset(path, buffer, contentType) {
  await ensurePrivateBucket();
  const { data, error } = await storageClient().storage.from(bucketName()).upload(path, buffer, { contentType, upsert: false, cacheControl: '3600' });
  if (error) throw new Error('Supabase Storage could not save the profile asset.');
  return data;
}

export async function signedAssetUrl(path) {
  await ensurePrivateBucket();
  const { data, error } = await storageClient().storage.from(bucketName()).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) throw new Error('Supabase Storage could not create an asset link.');
  return data.signedUrl;
}

export async function removeProfileAsset(path) {
  const { error } = await storageClient().storage.from(bucketName()).remove([path]);
  if (error) throw new Error('Supabase Storage could not remove an unused profile asset.');
}
