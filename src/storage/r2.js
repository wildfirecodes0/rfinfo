// Cloudflare R2 via the S3-compatible API. All features degrade gracefully if R2 is not configured.
const cfg = require('../config');

const enabled = !!(cfg.R2_ACCOUNT_ID && cfg.R2_ACCESS_KEY_ID && cfg.R2_SECRET_ACCESS_KEY && cfg.R2_BUCKET);

let client = null;
let S3 = null;
let presign = null;
if (enabled) {
  S3 = require('@aws-sdk/client-s3');
  presign = require('@aws-sdk/s3-request-presigner').getSignedUrl;
  client = new S3.S3Client({
    region: 'auto',
    endpoint: `https://${cfg.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: cfg.R2_ACCESS_KEY_ID, secretAccessKey: cfg.R2_SECRET_ACCESS_KEY },
  });
}

function ensure() {
  if (!enabled) throw new Error('R2 storage is not configured (set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)');
}

async function put(key, body, contentType = 'application/octet-stream') {
  ensure();
  await client.send(new S3.PutObjectCommand({ Bucket: cfg.R2_BUCKET, Key: key, Body: body, ContentType: contentType }));
  return key;
}

async function getBuffer(key) {
  ensure();
  const res = await client.send(new S3.GetObjectCommand({ Bucket: cfg.R2_BUCKET, Key: key }));
  return Buffer.from(await res.Body.transformToByteArray());
}

async function list(prefix) {
  ensure();
  const res = await client.send(new S3.ListObjectsV2Command({ Bucket: cfg.R2_BUCKET, Prefix: prefix, MaxKeys: 1000 }));
  return (res.Contents || [])
    .map((o) => ({ key: o.Key, size: o.Size, modified: o.LastModified }))
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

async function del(key) {
  ensure();
  await client.send(new S3.DeleteObjectCommand({ Bucket: cfg.R2_BUCKET, Key: key }));
}

async function signedUrl(key, seconds = 900) {
  ensure();
  return presign(client, new S3.GetObjectCommand({ Bucket: cfg.R2_BUCKET, Key: key }), { expiresIn: seconds });
}

const publicUrl = (key) => (cfg.R2_PUBLIC_URL ? `${cfg.R2_PUBLIC_URL}/${key}` : null);

module.exports = { enabled, put, getBuffer, list, del, signedUrl, publicUrl };
