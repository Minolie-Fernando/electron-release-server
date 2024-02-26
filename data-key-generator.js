const crypto = require('crypto');

const dataEncryptionKeys = crypto.randomBytes(32).toString('base64');

console.log("DATA ENCRPYITON KEY = ", dataEncryptionKeys)