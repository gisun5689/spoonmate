import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const configPath = path.resolve(process.argv[2] || 'config/users.json');
const publicKeyPath = path.resolve(process.argv[3] || 'authorization-public-key.pem');
const outputPath = path.resolve(process.argv[4] || 'authorization-envelope.json');

const fail = (message) => {
    throw new Error(message);
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

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const configKeys = Object.keys(config).sort();
const expectedConfigKeys = ['schema_version', 'application_id', 'minimum_app_version', 'users'].sort();
if (JSON.stringify(configKeys) !== JSON.stringify(expectedConfigKeys)) fail('User registry fields are invalid.');
if (config.schema_version !== 1 || config.application_id !== 'spoonmate') fail('User registry schema or application ID is invalid.');
if (!/^\d+(?:\.\d+){0,3}$/.test(String(config.minimum_app_version || ''))) fail('minimum_app_version is invalid.');
if (!Array.isArray(config.users) || config.users.length === 0) fail('users must be a non-empty array.');

const seenUids = new Set();
const users = config.users.map((user) => {
    if (!user || typeof user !== 'object' || Array.isArray(user)) fail('Authorization user must be an object.');
    const userKeys = Object.keys(user).sort();
    const expectedUserKeys = ['spoon_uid', 'enabled', 'expires_at'].sort();
    if (JSON.stringify(userKeys) !== JSON.stringify(expectedUserKeys)) fail('Authorization user fields are invalid.');

    const spoonUid = String(user.spoon_uid || '');
    if (!/^\d+$/.test(spoonUid)) fail('Spoon UID is invalid.');
    if (seenUids.has(spoonUid)) fail(`Duplicate Spoon UID: ${spoonUid}`);
    seenUids.add(spoonUid);
    if (typeof user.enabled !== 'boolean') fail('enabled must be boolean.');
    if (user.expires_at !== null && !Number.isFinite(parseUtcTimestamp(user.expires_at))) {
        fail('expires_at must be null or canonical UTC ISO time.');
    }

    return {
        spoon_uid: spoonUid,
        enabled: user.enabled,
        expires_at: user.expires_at
    };
});

const revision = Number.parseInt(process.env.AUTHORIZATION_REVISION || '', 10);
if (!Number.isSafeInteger(revision) || revision < 1) fail('AUTHORIZATION_REVISION must be a positive safe integer.');

const privateKeyBase64 = String(process.env.AUTHORIZATION_ED25519_PRIVATE_KEY_BASE64 || '').trim();
if (!/^[A-Za-z0-9+/]+={0,2}$/.test(privateKeyBase64) || privateKeyBase64.length % 4 !== 0) {
    fail('AUTHORIZATION_ED25519_PRIVATE_KEY_BASE64 is missing or invalid.');
}
const privateKeyPem = Buffer.from(privateKeyBase64, 'base64').toString('utf8');
const privateKey = crypto.createPrivateKey(privateKeyPem);
if (privateKey.asymmetricKeyType !== 'ed25519') fail('Private key must be Ed25519.');

const expectedPublicKey = crypto.createPublicKey(fs.readFileSync(publicKeyPath, 'utf8'));
if (expectedPublicKey.asymmetricKeyType !== 'ed25519') fail('Public key must be Ed25519.');
const derivedPublicKey = crypto.createPublicKey(privateKey);
const expectedDer = expectedPublicKey.export({ type: 'spki', format: 'der' });
const derivedDer = derivedPublicKey.export({ type: 'spki', format: 'der' });
if (!crypto.timingSafeEqual(expectedDer, derivedDer)) fail('Private key does not match authorization-public-key.pem.');

const payload = {
    schema_version: 1,
    application_id: 'spoonmate',
    revision,
    issued_at: new Date().toISOString(),
    minimum_app_version: config.minimum_app_version,
    users
};
const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
const signatureBytes = crypto.sign(null, payloadBytes, privateKey);
const envelope = {
    envelope_version: 1,
    payload_base64: payloadBytes.toString('base64'),
    signature_base64: signatureBytes.toString('base64')
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({
    success: true,
    revision,
    minimum_app_version: payload.minimum_app_version,
    user_count: users.length,
    output: outputPath
}));
