const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const DB_PATH = path.join(__dirname, 'db.sqlite');
const KEY_PATH = path.join(__dirname, 'service-account.json');
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const FOLDER_ID = '1FjRTVO4rLCsKdeIg452M4-1MjpmfuChG'; // ID твоей папки на Google Диске

async function uploadBackup() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: SCOPES,
  });

  const drive = google.drive({ version: 'v3', auth });

  const fileMetadata = {
    name: `db-backup-${new Date().toISOString().slice(0, 10)}.sqlite`,
    parents: [FOLDER_ID],
  };

  const media = {
    mimeType: 'application/x-sqlite3',
    body: fs.createReadStream(DB_PATH),
  };

  try {
    const res = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: 'id, name',
    });
    console.log(`✅ Backup uploaded: ${res.data.name}`);
  } catch (err) {
    console.error('❌ Error uploading backup:', err.message);
  }
}

uploadBackup();