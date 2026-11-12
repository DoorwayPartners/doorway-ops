/**
 * Doorway Ops V3.3 — Module 1: native PDF generator (apps-script/PdfEngine.js).
 *
 * Builds a branded HTML table and, in Apps Script, converts it to a PDF blob.
 * GENERATE_PDF is Owner-only. The PDF is returned as base64 for the browser
 * to download. It is NOT saved to Drive: DriveApp would require a new OAuth
 * scope (https://www.googleapis.com/auth/drive or drive.file) and Cristian's
 * re-consent. HTML is escaped. Pay/rate figures are never invented — only
 * the caller-supplied, validated payload is rendered.
 */
var DoorwayPdf = (function () {
  var TYPES = ['SUMMARY', 'PAY_STUB', 'PERMIT_PACKET', 'BATTLECARD'];
  var MAX_ROWS = 200;
  var MAX_FIELD = 500;
  var MAX_SUMMARY = 2000;
  var MAX_TITLE = 120;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function clip(s, n) {
    var t = String(s == null ? '' : s);
    return t.length > n ? t.slice(0, n) : t;
  }
  function safeId(s) {
    return clip(s, 80).replace(/[^A-Za-z0-9_-]/g, '');
  }

  /**
   * Validate a GENERATE_PDF request. Owner-only. Unknown types and oversized
   * payloads are rejected before any HTML is built.
   */
  function checkGeneratePdf(user, params) {
    if (!user || user.role !== 'Owner') return { ok: false, status: 403, error: 'owner_only' };
    params = params || {};
    var type = String(params.type || params.pdfType || 'SUMMARY').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (TYPES.indexOf(type) < 0) return { ok: false, status: 400, error: 'bad_pdf_type' };
    var d = (params.payload && typeof params.payload === 'object' && !Array.isArray(params.payload))
      ? params.payload : params;
    var rows = Array.isArray(d.rows) ? d.rows : [];
    if (rows.length > MAX_ROWS) return { ok: false, status: 400, error: 'too_many_rows', detail: MAX_ROWS };
    var safeRows = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || {};
      safeRows.push({
        col1: clip(r.col1, MAX_FIELD),
        col2: clip(r.col2, MAX_FIELD),
        col3: clip(r.col3, MAX_FIELD)
      });
    }
    return {
      ok: true,
      type: type,
      payload: {
        id: safeId(d.id),
        title: clip(d.title, MAX_TITLE),
        summary: clip(d.summary, MAX_SUMMARY),
        h1: clip(d.h1, 60),
        h2: clip(d.h2, 60),
        h3: clip(d.h3, 60),
        generatedAt: clip(d.generatedAt, 80),
        rows: safeRows
      }
    };
  }

  function buildPdfHtml(type, d) {
    d = d || {};
    var rowsHtml = (d.rows || []).map(function (r) {
      return '<tr><td style="padding:6px;border:1px solid #cbd5e1;">' + escapeHtml(r.col1 || '') + '</td>' +
             '<td style="padding:6px;border:1px solid #cbd5e1;">' + escapeHtml(r.col2 || '') + '</td>' +
             '<td align="right" style="padding:6px;border:1px solid #cbd5e1;">' + escapeHtml(r.col3 || '') + '</td></tr>';
    }).join('');
    var when = d.generatedAt || '';
    return '<html><body style="font-family:Arial,sans-serif;color:#0f172a;padding:24px;">' +
      '<div style="background:#0f172a;color:#fff;padding:14px 18px;border-radius:8px;">' +
      '<h2 style="margin:0;">Doorway Partners — ' + escapeHtml(d.title || type) + '</h2>' +
      '<p style="margin:4px 0 0;font-size:12px;color:#cbd5e1;">Generated: ' + escapeHtml(when) + (when ? ' ET' : '') + '</p>' +
      '</div>' +
      '<p style="margin:14px 0;font-size:14px;">' + escapeHtml(d.summary || '') + '</p>' +
      '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
      '<thead><tr style="background:#f1f5f9;"><th align="left" style="padding:8px;border:1px solid #cbd5e1;">' + escapeHtml(d.h1 || 'Item') + '</th>' +
      '<th align="left" style="padding:8px;border:1px solid #cbd5e1;">' + escapeHtml(d.h2 || 'Detail') + '</th>' +
      '<th align="right" style="padding:8px;border:1px solid #cbd5e1;">' + escapeHtml(d.h3 || 'Amount / Status') + '</th></tr></thead>' +
      '<tbody>' + rowsHtml + '</tbody></table></body></html>';
  }

  function fileName(type, payload, stamp) {
    var id = payload && payload.id ? payload.id : (stamp || 'export');
    return 'Doorway_' + type + '_' + id + '.pdf';
  }

  return {
    TYPES: TYPES,
    MAX_ROWS: MAX_ROWS,
    escapeHtml: escapeHtml,
    checkGeneratePdf: checkGeneratePdf,
    buildPdfHtml: buildPdfHtml,
    fileName: fileName
  };
})();

/** Apps Script entry: HTML -> PDF blob, returned as base64 (no Drive write). */
function generateOpsPdf(type, payload) {
  payload = payload || {};
  if (!payload.generatedAt && typeof Utilities !== 'undefined') {
    payload.generatedAt = Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd HH:mm');
  }
  var html = DoorwayPdf.buildPdfHtml(type, payload);
  var fileName = DoorwayPdf.fileName(type, payload, payload.generatedAt && String(payload.generatedAt).replace(/[^0-9]/g, '').slice(0, 12));
  if (typeof Utilities === 'undefined') {
    return { status: 200, title: fileName, html: html };
  }
  var blob = Utilities.newBlob(html, 'text/html', 'temp.html').getAs('application/pdf');
  blob.setName(fileName);
  return {
    status: 200,
    title: fileName,
    mimeType: 'application/pdf',
    base64: Utilities.base64Encode(blob.getBytes())
  };
}

function handleGeneratePdf_(user, req) {
  var check = DoorwayPdf.checkGeneratePdf(user, req);
  if (!check.ok) return { status: check.status, error: check.error, detail: check.detail };
  return generateOpsPdf(check.type, check.payload);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DoorwayPdf;
}
