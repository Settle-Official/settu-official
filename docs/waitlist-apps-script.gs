/**
 * Settu API waitlist → Google Sheet.
 * Paste into the sheet's Extensions → Apps Script, set the SECRET script
 * property, and deploy as a web app (Execute as: Me, Who has access: Anyone).
 * The Settu server (src/lib/waitlist/sheets.ts) POSTs {secret, headers, row}.
 */
const TAB = 'Waitlist';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
    if (!secret || body.secret !== secret) return json({ ok: false, error: 'bad secret' });
    if (!Array.isArray(body.row) || body.row.length > 40) return json({ ok: false, error: 'bad row' });

    const lock = LockService.getScriptLock();
    lock.waitLock(10000); // two sign-ups at once must not overwrite each other
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const sheet = ss.getSheetByName(TAB) || ss.insertSheet(TAB);
      if (sheet.getLastRow() === 0 && Array.isArray(body.headers)) {
        sheet.appendRow(body.headers);
        sheet.getRange(1, 1, 1, body.headers.length).setFontWeight('bold');
        sheet.setFrozenRows(1);
      }
      // Stored as plain text so nothing a sign-up types runs as a formula.
      const row = body.row.map(String);
      const r = sheet.getLastRow() + 1;
      sheet.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
    } finally {
      lock.releaseLock();
    }
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
