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
    to: CONFIG.MANAGER,
    subject: "Sarah bounce alert: " + bounced,
    body: "Hi,\n\nAn email appears to have bounced or failed delivery.\n\nBounced recipient: " + bounced + "\nFrom: " + from + "\nSubject: " + subject + "\n\nSnippet:\n" + body.substring(0, 1200) + "\n\nSarah"
  });
  logAction(from, subject, "bounce", "manager_alerted", "", bounced, "Undeliverable/bounce detected");
  thread.addLabel(getOrCreateLabel(CONFIG.LABEL_BOUNCE));
  thread.markRead();
}
function handleUnsureEmail(thread, subject, body, from, reason) {
  sendEmail({
    to: CONFIG.MANAGER,
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
  if (params.bcc) opts.bcc = params.bcc;
  if (params.cc) opts.cc = params.cc;
  GmailApp.sendEmail(params.to, params.subject, params.body, opts);
}

// Use this instead of sendEmail() whenever Sarah is continuing an
// existing conversation (a lead reply, a follow-up). GmailApp.sendEmail()
// composes a brand-new message with no In-Reply-To/References headers,
// so even with a "Re:" subject Gmail (and the recipient's client) may
// not thread it with the original conversation. sourceMsg.reply() sets
// those headers correctly and replies to whoever actually sent that
// message, keeping the full history visible in one thread.
function sendReplyToMessage(sourceMsg, body, params) {
  params = params || {};
  var opts = { from: CONFIG.FROM_EMAIL, name: CONFIG.FROM_NAME };
  if (params.bcc) opts.bcc = params.bcc;
  if (params.cc) opts.cc = params.cc;
  sourceMsg.reply(body, opts);
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