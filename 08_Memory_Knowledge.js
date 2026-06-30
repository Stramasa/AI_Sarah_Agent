function maybeLearnFromSession(sessionLog, memory) {
  if (!sessionLog || sessionLog.length === 0) return;
  var props = PropertiesService.getScriptProperties();
  var last = parseInt(props.getProperty("last_learning_ts") || "0", 10);
  var now = new Date().getTime();
  if (last && ((now - last) / 3600000) < CONFIG.LEARNING_INTERVAL_HOURS) return;

  var prompt =
    "Sarah is allowed to observe patterns from email operations, but not to rewrite rules or take new authority.\n" +
    "Based on this session, is there one useful operational learning to remember?\n" +
    "Return exactly NOTHING if there is no clear pattern. Otherwise return one line starting with LEARNING: and keep it factual, safe, and under 180 chars.\n\n" +
    "Recent session:\n" + sessionLog.join("\n") + "\n\nExisting memory excerpt:\n" + (memory || "").substring(0, 2500);
  try {
    var r = callClaude(prompt, "claude-haiku-4-5-20251001").trim();
    if (r.indexOf("LEARNING:") === 0) writeToMemory(r);
    props.setProperty("last_learning_ts", String(now));
  } catch(e) { Logger.log("Learning error: " + e); }
}
function updateMemoryBrief(type, context) {
  try {
    var prompt = "Write one factual Sarah memory note under 120 chars. No advice. Type: " + type + "\nContext: " + context.substring(0, 500) + "\nReply with ONLY the note.";
    writeToMemory(type + ": " + callClaude(prompt, "claude-haiku-4-5-20251001").trim());
  } catch(e) { Logger.log("Memory brief error: " + e); }
}
function loadInstructions() {
  try {
    var doc = DocumentApp.openById(CONFIG.INSTRUCTIONS_FILE_ID);
    return doc.getBody().getText();
  } catch(e) { Logger.log("INSTRUCTIONS load error: " + e); return ""; }
}
function loadKnowledge() {
  try {
    if (!CONFIG.KNOWLEDGE_FILE_ID || CONFIG.KNOWLEDGE_FILE_ID === "PASTE_KNOWLEDGE_DOC_ID_HERE") {
      Logger.log("KNOWLEDGE: no knowledge doc configured yet");
      return "";
    }
    var doc = DocumentApp.openById(CONFIG.KNOWLEDGE_FILE_ID);
    return doc.getBody().getText();
  } catch(e) { Logger.log("KNOWLEDGE load error: " + e); return ""; }
}
function buildSarahContext(mode, emailText, instructions, knowledge) {
  var relevantKnowledge = selectRelevantKnowledge(mode, emailText, knowledge || "");
  return "SARAH INSTRUCTIONS:\n" + (instructions || "") +
    "\n\nSARAH RELEVANT KNOWLEDGE:\n" + relevantKnowledge;
}
function selectRelevantKnowledge(mode, emailText, knowledge) {
  if (!knowledge) return "";
  var maxChars = 4500;
  var text = knowledge;
  var lowerEmail = (emailText || "").toLowerCase();

  // Keep this cheap: no Claude call. Just include the most useful recent/relevant chunks by keyword.
  var lines = text.split(/\n/);
  var picked = [];
  var keywords = [];

  if (mode === "lead") keywords = ["lead", "sales", "seo", "web", "website", "paid", "ads", "commission", "revenue", "recruitshore", "introlynk", "axpira", "vientra"];
  else if (mode === "client") keywords = ["client", "project", "deadline", "blocker", "pm", "owner", "preference"];
  else if (mode === "learning") keywords = ["learning", "pattern", "spam", "lead", "client"];

  // Include recent tail first, because the latest knowledge is usually most useful.
  var tail = lines.slice(Math.max(0, lines.length - 80)).join("\n");
  picked.push(tail);

  // Add lines whose text matches the email or mode keywords.
  lines.forEach(function(line) {
    var l = line.toLowerCase();
    var match = false;
    keywords.forEach(function(k) { if (l.indexOf(k) !== -1 || lowerEmail.indexOf(k) !== -1 && l.indexOf(k) !== -1) match = true; });
    if (match) picked.push(line);
  });

  var joined = picked.join("\n");
  if (joined.length > maxChars) joined = joined.substring(joined.length - maxChars);
  return joined;
}
function writeToMemory(note) {
  try {
    if (!CONFIG.KNOWLEDGE_FILE_ID || CONFIG.KNOWLEDGE_FILE_ID === "PASTE_KNOWLEDGE_DOC_ID_HERE") {
      Logger.log("KNOWLEDGE write skipped: set KNOWLEDGE_FILE_ID Script Property first");
      return;
    }
    var doc = DocumentApp.openById(CONFIG.KNOWLEDGE_FILE_ID);
    var timestamp = Utilities.formatDate(new Date(), CONFIG.CALENDAR_TZ, "yyyy-MM-dd HH:mm");
    doc.getBody().appendParagraph("[" + timestamp + "] " + note);
    doc.saveAndClose();
  } catch(e) { Logger.log("KNOWLEDGE write error: " + e); }
}

// Backwards-compatible name, in case any older function still calls loadMemory().
function loadMemory() {
  return buildSarahContext("general", "", loadInstructions(), loadKnowledge());
}
function buildEmailSystem(memory, brand) {
  return (memory && memory.length > 0 ? memory : "You are Sarah, client services at " + brand + ".") +
    "\n\nSTRICT EMAIL RULES: Plain text only. No markdown. No asterisks. No bullets except coded slot lines. No em dashes. Never mention AI, automation, scripts, or Claude. Keep emails short. Never invent calendar dates, weekdays, or free times. Never mention PHT in external emails.";
}
