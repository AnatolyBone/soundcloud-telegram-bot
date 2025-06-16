const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { authenticate } = require('@google-cloud/local-auth');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const DB_PATH = path.join(__dirname, 'db.sqlite');

async function authorize() {
  const auth = await authenticate({
    keyfilePath: path.join(__dirname, 'credentials.json'),
    scopes: SCOPES,
  });
  return google.drive({ version: 'v3', auth });
}

async function uploadBackup() {
  const drive = await authorize();

  const fileMetadata = {
    name: `db-backup-${new Date().toISOString().slice(0, 10)}.sqlite`
  };

  const media = {
    mimeType: 'application/x-sqlite3',
    body: fs.createReadStream(DB_PATH)
  };

  try {
    const res = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name'
    });
    console.log(`✅ Backup uploaded: ${res.data.name}`);
  } catch (err) {
    console.error('❌ Error uploading backup:', err.message);
  }
}

uploadBackup();