import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

const envelopePath = path.resolve(process.argv[2] || 'authorization-envelope.json');
const publicKeyPath = path.resolve(process.argv[3] || 'authorization-public-key.pem');

const fail = (message) => {
    throw new Error(message);
};

const decodeCanonicalBase64 = (value, label) => {
    const text = String(value || '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) fail(`${label} Base64 format is invalid.`);
    const bytes = Buffer.from(text, 'base64');
    if (bytes.toString('base64') !== text) fail(`${label} Base64 is not canonical.`);
    return bytes;
};

const parseUtcTimestamp = (value) => {
    const text = String(value || '');
    const match = text.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/);
    if (!match) return NaN;
    const timestamp = Date.parse(text);
    if (!Number.isFinite(timestamp)) return NaN;
    const canonical = `${match[1]}.${String(match[2] || '').padEnd(3, '0')}Z`;
    return new Date(timestamp).toISOString() === canonical ? timestamp : NaN;
};

const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
const envelopeKeys = Object.keys(envelope).sort();
const expectedEnvelopeKeys = ['envelope_version', 'payload_base64', 'signature_base64'].sort();
if (JSON.stringify(envelopeKeys) !== JSON.stringify(expectedEnvelopeKeys)) fail('Envelope fields are invalid.');
if (envelope.envelope_version !== 1) fail('Unsupported envelope version.');

const payloadBytes = decodeCanonicalBase64(envelope.payload_base64, 'payload');
const signatureBytes = decodeCanonicalBase64(envelope.signature_base64, 'signature');
if (signatureBytes.length !== 64) fail('Ed25519 signature must be 64 bytes.');

const publicKey = crypto.createPublicKey(fs.readFileSync(publicKeyPath, 'utf8'));
if (publicKey.asymmetricKeyType !== 'ed25519') fail('Public key must be Ed25519.');
if (!crypto.verify(null, payloadBytes, publicKey, signatureBytes)) fail('Ed25519 signature verification failed.');

const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes));
const payloadKeys = Object.keys(payload).sort();
const expectedPayloadKeys = ['schema_version', 'application_id', 'revision', 'issued_at', 'minimum_app_version', 'users'].sort();
if (JSON.stringify(payloadKeys) !== JSON.stringify(expectedPayloadKeys)) fail('Payload fields are invalid.');
if (payload.schema_version !== 1 || payload.application_id !== 'spoonmate') fail('Payload schema or application ID is invalid.');
if (!Number.isSafeInteger(payload.revision) || payload.revision < 0) fail('Revision is invalid.');
if (!Number.isFinite(parseUtcTimestamp(payload.issued_at))) fail('issued_at must be canonical UTC ISO time.');
if (!/^\d+(?:\.\d+){0,3}$/.test(String(payload.minimum_app_version || ''))) fail('minimum_app_version is invalid.');
if (!Array.isArray(payload.users)) fail('users must be an array.');

const seenUids = new Set();
for (const user of payload.users) {
    if (!user || typeof user !== 'object' || Array.isArray(user)) fail('Authorization user must be an object.');
    const userKeys = Object.keys(user).sort();
    const expectedUserKeys = ['spoon_uid', 'enabled', 'expires_at'].sort();
    if (JSON.stringify(userKeys) !== JSON.stringify(expectedUserKeys)) fail('Authorization user fields are invalid.');
    if (!/^\d+$/.test(String(user.spoon_uid || ''))) fail('Spoon UID is invalid.');
    if (seenUids.has(user.spoon_uid)) fail('Duplicate Spoon UID.');
    seenUids.add(user.spoon_uid);
    if (typeof user.enabled !== 'boolean') fail('enabled must be boolean.');
    if (user.expires_at !== null && !Number.isFinite(parseUtcTimestamp(user.expires_at))) fail('expires_at must be null or canonical UTC ISO time.');
}

console.log(JSON.stringify({
    success: true,
    revision: payload.revision,
    minimum_app_version: payload.minimum_app_version,
    user_count: payload.users.length
}));

