function handleCalendlyConfirmation(thread, subject, body, from) {
  var info = extractCalendlyInfo(subject, body);
  logAction(from, subject, "system", "calendly_logged_no_reply", info.name || "", info.email || "", "Booking confirmation logged. No reply sent.");
  updateLeadStatus(info.email, "booked", "Calendly booking: " + (info.when || subject));
  updateMemoryBrief("BOOKING", "Calendly booking logged for " + (info.email || info.name || "unknown") + ": " + (info.when || subject));
  thread.addLabel(getOrCreateLabel(CONFIG.LABEL_SYSTEM));
  thread.markRead();
}
function handleBounceEmail(thread, subject, body, from) {
  var bounced = extractBouncedRecipient(body) || "unknown recipient";
  sendEmail({
    to: CONFIG.ESCALATION_TO,
    cc: CONFIG.ESCALATION_CC,
    subject: "Sarah bounce alert: " + bounced,
    body: "Hi,\n\nAn email appears to have bounced or failed delivery.\n\nBounced recipient: " + bounced + "\nFrom: " + from + "\nSubject: " + subject + "\n\nSnippet:\n" + body.substring(0, 1200) + "\n\nSarah"
  });
  logAction(from, subject, "bounce", "manager_alerted", "", bounced, "Undeliverable/bounce detected");
  thread.addLabel(getOrCreateLabel(CONFIG.LABEL_BOUNCE));
  thread.markRead();
}
function handleUnsureEmail(thread, subject, body, from, reason) {
  sendEmail({
    to: CONFIG.ESCALATION_TO,
    cc: CONFIG.ESCALATION_CC,
    subject: "Sarah unsure: " + subject,
    body: "Hi,\n\nI received an email I was not fully sure how to handle.\n\nReason: " + (reason || "Unclear") + "\nFrom: " + from + "\nSubject: " + subject + "\n\nSnippet:\n" + body.substring(0, 1200) + "\n\nSarah"
  });
  logAction(from, subject, "unsure", "manager_alerted", "", extractEmail(from), reason || "Forwarded to manager");
  thread.addLabel(getOrCreateLabel(CONFIG.LABEL_UNSURE));
  thread.markRead();
}
function rescueForwardedLeadsFromSpam() {
  CONFIG.FORWARDERS.forEach(function(f) {
    try { GmailApp.search("in:spam is:unread from:" + f + " -label:" + CONFIG.LABEL_PROCESSED, 0, 10).forEach(function(t) { t.moveToInbox(); }); }
    catch(e) { Logger.log("Spam rescue error: " + e); }
  });
}
function sendEmail(params) {
  var opts = { from: CONFIG.FROM_EMAIL, name: CONFIG.FROM_NAME };

  // Merge caller-supplied BCC with ALWAYS_BCC so team visibility is guaranteed
  // on every outbound email without the caller needing to remember to add it.
  var bccSet = (CONFIG.ALWAYS_BCC || []).slice();
  if (params.bcc) {
    params.bcc.split(",").forEach(function(b) {
      var t = b.trim();
      if (t && bccSet.indexOf(t) === -1) bccSet.push(t);
    });
  }
  if (bccSet.length) opts.bcc = bccSet.join(",");
  if (params.cc) opts.cc = params.cc;

  GmailApp.sendEmail(params.to, params.subject, params.body, opts);
}

// Use this instead of sendEmail() whenever Sarah is continuing an
// existing conversation (a lead reply, a follow-up). GmailApp.sendEmail()
// composes a brand-new message with no In-Reply-To/References headers,
// so even with a "Re:" subject Gmail (and the recipient's client) won't
// thread it with the original conversation. sourceMsg.reply() sets
// those headers correctly and replies to whoever actually sent that
// message, keeping the full history visible in one thread.
// The previous message is quoted at the bottom (standard email convention).
function sendReplyToMessage(sourceMsg, body, params) {
  params = params || {};
  var opts = { from: CONFIG.FROM_EMAIL, name: CONFIG.FROM_NAME };

  // Same ALWAYS_BCC merging as sendEmail — every outbound reply includes team BCC.
  var bccSet = (CONFIG.ALWAYS_BCC || []).slice();
  if (params.bcc) {
    params.bcc.split(",").forEach(function(b) {
      var t = b.trim();
      if (t && bccSet.indexOf(t) === -1) bccSet.push(t);
    });
  }
  if (bccSet.length) opts.bcc = bccSet.join(",");
  if (params.cc) opts.cc = params.cc;

  // Append a quoted version of the message being replied to so the
  // recipient sees the context (standard email client behaviour).
  var originalDate = "";
  try { originalDate = Utilities.formatDate(sourceMsg.getDate(), CONFIG.CALENDAR_TZ, "EEE, d MMM yyyy 'at' HH:mm"); } catch(e) {}
  var originalFrom = sourceMsg.getFrom() || "";
  var originalBody = (sourceMsg.getPlainBody() || "").substring(0, 2000);
  var quotedBlock =
    "\n\n---\nOn " + originalDate + ", " + originalFrom + " wrote:\n" +
    originalBody.split("\n").map(function(l) { return "> " + l; }).join("\n");

  sourceMsg.reply(body + quotedBlock, opts);
}
function isCalendlyConfirmation(subject, from, body) {
  var s = (subject || "").toLowerCase();
  var f = (from || "").toLowerCase();
  return (f.indexOf("calendly") !== -1 || s.indexOf("calendly") !== -1 || s.indexOf("new event:") !== -1 || s.indexOf("a new event has been scheduled") !== -1) &&
         (s.indexOf("scheduled") !== -1 || s.indexOf("new event") !== -1 || (body || "").toLowerCase().indexOf("invitee") !== -1);
}
function isBounceEmail(subject, body, from) {
  var text = ((subject || "") + " " + (body || "") + " " + (from || "")).toLowerCase();
  return text.indexOf("undeliverable") !== -1 || text.indexOf("delivery status notification") !== -1 || text.indexOf("delivery incomplete") !== -1 || text.indexOf("message not delivered") !== -1 || text.indexOf("mail delivery subsystem") !== -1 || text.indexOf("mailer-daemon") !== -1 || text.indexOf("address not found") !== -1 || text.indexOf("delivery has failed") !== -1;
}
function extractBouncedRecipient(body) {
  var m = (body || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig);
  if (!m || m.length === 0) return "";
  for (var i = 0; i < m.length; i++) if (!isInternalEmail(m[i]) && m[i].indexOf("mailer-daemon") === -1) return m[i];
  return m[0];
}
function extractCalendlyInfo(subject, body) {
  var text = subject + "\n" + body;
  var emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
  var email = "";
  for (var i = 0; i < emails.length; i++) if (!isInternalEmail(emails[i]) && emails[i].toLowerCase().indexOf("calendly") === -1) { email = emails[i]; break; }
  var when = "";
  var whenMatch = text.match(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[^\n]{0,80}(\d{1,2}:\d{2}|\d{1,2}\s?(am|pm))/i);
  if (whenMatch) when = whenMatch[0];
  return { email: email, name: "", when: when };
}

// Lightweight keyword check — no Claude call needed — to detect whether
// an email is asking to schedule a meeting. Used to decide if a forwarded
// "client" email should get a calendar reply vs an internal log update.
function looksLikeSchedulingRequest(body) {
  var t = (body || "").toLowerCase();
  var keywords = [
    "available", "availability", "schedule", "scheduling", "meeting",
    "call", "catch up", "catch-up", "coordinate", "book a time",
    "set up a time", "find a time", "next week", "this week",
    "would you be free", "when are you", "what time", "what times",
    "works for you", "work for you", "connect", "sync up", "sync"
  ];
  for (var i = 0; i < keywords.length; i++) {
    if (t.indexOf(keywords[i]) !== -1) return true;
  }
  return false;
}

// ---- Spam cleanup (run once per day on a separate trigger) ----------
// Goes through the Gmail spam folder. For each thread:
//   - If it looks like a real email (lead/client/legit), rescue it to inbox
//     with label "RecoveredFromSpam".
//   - Otherwise, trash it with label "SpamCleaned" (visible for 30 days).
function cleanSpam() {
  Logger.log("=== cleanSpam START ===");

  var recoveredLabel = getOrCreateLabel("RecoveredFromSpam");
  var cleanedLabel = getOrCreateLabel("SpamCleaned");
  var spamThreads = GmailApp.search("in:spam -label:RecoveredFromSpam -label:SpamCleaned", 0, 50);

  Logger.log("Spam threads to review: " + spamThreads.length);

  spamThreads.forEach(function(thread) {
    try {
      var messages = thread.getMessages();
      var msg = messages[messages.length - 1];
      var subject = msg.getSubject() || "";
      var body = msg.getPlainBody() || "";
      var from = msg.getFrom() || "";

      // Always rescue forwarded leads that got spam-filtered
      var fromEmail = extractEmail(from);
      if (isKnownForwarder(fromEmail) || isInternalForwarder(fromEmail)) {
        thread.moveToInbox();
        thread.addLabel(recoveredLabel);
        Logger.log("Rescued forwarder email from spam: " + subject);
        return;
      }

      // Ask Claude if this looks legit
      var prompt =
        "Is this a real email worth reading — a potential client, business contact, partner, or colleague?\n" +
        "Or is it clearly automated spam, a newsletter, a vendor cold pitch, a phishing attempt, or a promotional message?\n\n" +
        "Answer with only one word: LEGIT or SPAM\n\n" +
        "From: " + from + "\nSubject: " + subject + "\nBody:\n" + body.substring(0, 800);

      var verdict = "";
      try {
        verdict = callClaude(prompt, "claude-haiku-4-5-20251001").trim().toUpperCase();
      } catch(e) {
        Logger.log("cleanSpam Claude error: " + e);
        verdict = "SPAM"; // safe default — don't rescue if uncertain
      }

      if (verdict.indexOf("LEGIT") !== -1) {
        thread.moveToInbox();
        thread.addLabel(recoveredLabel);
        Logger.log("Recovered legit email from spam: " + subject + " | from: " + from);
      } else {
        thread.moveToTrash();
        thread.addLabel(cleanedLabel);
        Logger.log("Trashed spam: " + subject);
      }
    } catch(e) {
      Logger.log("cleanSpam error on thread: " + e);
    }
  });

  Logger.log("=== cleanSpam END ===");
}