function ensureAllSheets() {
  for (var tab in SHEET_HEADERS) ensureSheetHeaders(tab, SHEET_HEADERS[tab]);
}
function ensureSheetHeaders(tab, desiredHeaders) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(tab) || ss.insertSheet(tab);
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var hasAny = existing.join("").trim() !== "";
  if (!hasAny) {
    sheet.getRange(1, 1, 1, desiredHeaders.length).setValues([desiredHeaders]);
    return;
  }
  var headers = existing.slice();
  desiredHeaders.forEach(function(h) {
    if (headers.indexOf(h) === -1) {
      headers.push(h);
      sheet.getRange(1, headers.length).setValue(h);
    }
  });
}
function appendObjectRow(tab, obj) {
  ensureSheetHeaders(tab, SHEET_HEADERS[tab]);
  var sheet = getSheet(tab);
  var headers = getHeaders(sheet);
  var row = headers.map(function(h) { return obj[h] !== undefined ? obj[h] : ""; });
  sheet.appendRow(row);
}
function logAction(from, subject, classification, action, relatedClient, notes, relatedEmail, reason) {
  appendObjectRow("Log", {
    "Timestamp": isoNow(),
    "From": from || "",
    "Subject": subject || "",
    "Classification": classification || "",
    "Action": action || "",
    "Related Client": relatedClient || "",
    "Notes": notes || "",
    "Related Email": relatedEmail || "",
    "Reason": reason || ""
  });
}
function getSheet(tab) { return SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(tab); }
function getHeaders(sheet) { return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]; }
function headerMap(headers) { var m = {}; headers.forEach(function(h, i) { if (h) m[String(h).trim()] = i; }); return m; }
function val(row, map, header) { return map[header] !== undefined ? row[map[header]] : ""; }
function setByHeader(sheet, rowNum, map, header, value) { if (map[header] !== undefined) sheet.getRange(rowNum, map[header] + 1).setValue(value); }
function getByHeader(sheet, rowNum, map, header) { return map[header] !== undefined ? sheet.getRange(rowNum, map[header] + 1).getValue() : ""; }
function isoNow() { return new Date().toISOString(); }
function detectBrand(text) {
  var lower = (text || "").toLowerCase();
  for (var i = 0; i < BRAND_MAP.length; i++) {
    for (var j = 0; j < BRAND_MAP[i].keywords.length; j++) {
      if (lower.indexOf(BRAND_MAP[i].keywords[j]) !== -1) return BRAND_MAP[i].brand;
    }
  }
  return DEFAULT_BRAND;
}
function extractEmail(from) {
  var m = (from || "").match(/<(.+?)>/);
  return m ? m[1].trim() : (from || "").trim();
}
function isInternalEmail(email) {
  return (email || "").toLowerCase().indexOf("@stramasa.com") !== -1;
}
function subjectWithRe(subject) {
  return (subject || "").toLowerCase().indexOf("re:") === 0 ? subject : "Re: " + subject;
}
function stripMarkdown(text) {
  return (text || "")
    .replace(/^subject\s*:\s*.*(\r?\n)+/i, "")
    .replace(/^\s*email body\s*:\s*/i, "")
    .replace(/^\s*body\s*:\s*/i, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/\_\_(.+?)\_\_/g, "$1")
    .replace(/\_(.+?)\_/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/[—]/g, "-")
    .trim();
}
function getOrCreateLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

// Returns a lead row object by searching the Leads sheet on the given column.
// Result includes a reference to the live Sheet + rowIndex so callers can write
// back without doing a second lookup.
function _leadRowLookup(keyField, keyValue) {
  if (!keyValue) return null;
  try {
    var sheet = getSheet("Leads");
    if (!sheet) return null;
    var rows = sheet.getDataRange().getValues();
    if (rows.length < 2) return null;
    var map = headerMap(rows[0]);
    var needle = String(keyValue).toLowerCase();
    for (var i = 1; i < rows.length; i++) {
      if (String(val(rows[i], map, keyField) || "").toLowerCase() !== needle) continue;
      return {
        sheet:         sheet,
        rowIndex:      i + 1,
        map:           map,
        email:         val(rows[i], map, "Email") || "",
        name:          val(rows[i], map, "Name") || "",
        brand:         val(rows[i], map, "Brand") || "",
        subject:       val(rows[i], map, "SourceSubject") || "",
        status:        val(rows[i], map, "Status") || "",
        threadId:      val(rows[i], map, "ThreadId") || "",
        followUpCount: parseInt(val(rows[i], map, "FollowUpCount") || "0", 10) || 0,
        followUpSentAt: val(rows[i], map, "FollowUpSentAt") || "",
        replyCount:    parseInt(val(rows[i], map, "ReplyCount") || "0", 10) || 0
      };
    }
  } catch(e) {
    Logger.log("_leadRowLookup error (" + keyField + "=" + keyValue + "): " + e);
  }
  return null;
}
function findLeadSheetRowByThreadId(threadId) { return _leadRowLookup("ThreadId", threadId); }
function findLeadSheetRowByEmail(email)        { return _leadRowLookup("Email",    email);    }

// --- Admin / debug helpers ---
// Run listLeadProperties() from the Apps Script editor to see all pending
// follow-up records. Run deleteAllLeadProperties() to wipe them (e.g. after
// clearing out test leads from Gmail and the spreadsheet).
function listLeadProperties() {
  var props = PropertiesService.getScriptProperties().getProperties();
  Object.keys(props)
    .filter(function(k) { return k.indexOf(CONFIG.PROP_PREFIX) === 0; })
    .forEach(function(k) { Logger.log(k + " → " + props[k]); });
}
function deleteAllLeadProperties() {
  var ps = PropertiesService.getScriptProperties();
  Object.keys(ps.getProperties())
    .filter(function(k) { return k.indexOf(CONFIG.PROP_PREFIX) === 0; })
    .forEach(function(k) { ps.deleteProperty(k); Logger.log("Deleted: " + k); });
}
