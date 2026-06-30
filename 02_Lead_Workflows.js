function handleNewLead(thread, msg, classification, brand, memory) {
  var subject = msg.getSubject() || "";
  var body = msg.getPlainBody() || "";
  var from = msg.getFrom() || "";
  var threadId = thread.getId();
  var senderInfo = analyzeEmailSender(subject, body, from);
  var leadEmail = senderInfo.replyTo;
  var leadName = senderInfo.name || classification.name || "";

  if (!leadEmail || isInternalEmail(leadEmail)) {
    handleUnsureEmail(thread, subject, body, from, "Could not determine external lead email");
    return;
  }

  var tzRegion = detectTimezoneRegion(body + " " + from + " " + leadEmail);
  var slots = getAvailableSlots(tzRegion);
  var replySubject = generateSubjectLine(classification, brand, body);
  var replyBody = generateLeadReply(classification, brand, body, slots, tzRegion, memory);

  sendEmail({ to: leadEmail, subject: replySubject, body: replyBody, bcc: CONFIG.MANAGER });

  appendObjectRow("Leads", {
    "Date": isoNow(),
    "Name": leadName,
    "Email": leadEmail,
    "Brand": brand,
    "Service": classification.service_interest || "",
    "Status": "contacted",
    "LastContact": isoNow(),
    "SourceSubject": subject,
    "LastEmailDateTime": isoNow(),
    "LastEmailSubject": subject,
    "Notes": "Initial Sarah reply sent. TZ: " + tzRegion
  });

  PropertiesService.getScriptProperties().setProperty(
    CONFIG.PROP_PREFIX + threadId,
    JSON.stringify({ threadId: threadId, leadEmail: leadEmail, leadName: leadName, subject: subject, brand: brand, sentAt: new Date().getTime(), followUpCount: 0, replied: false })
  );

  thread.addLabel(getOrCreateLabel(CONFIG.LABEL_LEAD));
  thread.addLabel(getOrCreateLabel(CONFIG.LABEL_FOLLOWUP));
  thread.markRead();

  updateMemoryBrief("LEAD", "New lead " + leadName + " <" + leadEmail + "> for " + brand + ": " + (classification.service_interest || "unspecified service"));
  logAction(from, subject, "lead", "replied", "", leadEmail, "Initial reply sent with coded calendar slots");
}
function handleLeadReply(thread, memory) {
  var messages = thread.getMessages();
  var lastMsg = messages[messages.length - 1];
  var from = lastMsg.getFrom() || "";
  var body = lastMsg.getPlainBody() || "";
  var subject = lastMsg.getSubject() || "";
  var threadId = thread.getId();

  if (extractEmail(from) === CONFIG.FROM_EMAIL) return;

  var props = PropertiesService.getScriptProperties();
  var key = CONFIG.PROP_PREFIX + threadId;
  var data = JSON.parse(props.getProperty(key) || "{}");
  var replyToEmail = data.leadEmail || extractEmail(from);
  var brand = data.brand || DEFAULT_BRAND;
  var name = data.leadName || "";
  var tzRegion = detectTimezoneRegion(body + " " + from + " " + replyToEmail);
  var offeredTime = extractOfferedTime(body);
  var slots = getAvailableSlots(tzRegion);

  var replyText = generateLeadContextualReply(body, subject, brand, name, offeredTime, slots, tzRegion, memory);
  sendEmail({ to: replyToEmail, subject: subjectWithRe(subject), body: replyText, bcc: CONFIG.MANAGER });

  if (data.threadId) {
    data.replied = true;
    props.setProperty(key, JSON.stringify(data));
  }

  updateLeadStatus(replyToEmail, "replied", "Lead replied. Offered time: " + (offeredTime || "none"));
  logAction(from, subject, "lead", "contextual_reply", "", replyToEmail, "Replied to lead reply");
  updateMemoryBrief("REPLY", "Lead reply handled for " + replyToEmail + ". Offered time: " + (offeredTime || "none"));
  thread.markRead();
}
function generateSubjectLine(classification, brand, body) {
  var prompt =
    "Write a short reply subject line for " + brand + ".\n" +
    "Format: Topic | Name - Brand\n" +
    "No markdown. No quotes.\n" +
    "Name: " + (classification.name || "") + " Company: " + (classification.company || "") + " Service: " + (classification.service_interest || "") + "\n" +
    "Snippet: " + body.substring(0, 250) + "\n\n" +
    "Reply with ONLY the subject line.";
  try { return callClaude(prompt, "claude-haiku-4-5-20251001").trim(); }
  catch(e) { return "Following up | " + brand; }
}
function generateLeadReply(classification, brand, body, slots, tzRegion, memory) {
  var name = classification.name || "there";
  var service = classification.service_interest || "your inquiry";
  var slotBlock = slots.length > 0
    ? "A few times that work on our end:\n" + slots.map(function(s) { return s; }).join("\n") + "\n\nOr book directly: " + CONFIG.CALENDLY
    : "You can book a time here: " + CONFIG.CALENDLY;
  var target = TARGET_TZ[tzRegion] || TARGET_TZ.US;
  var system = buildEmailSystem(memory, brand);
  var user =
    "Write the first reply to this inbound lead.\n\n" +
    "Brand: " + brand + "\nLead name: " + name + "\nInterest: " + service + "\nExternal timezone label to use: " + target.nice + "\n\n" +
    "Use the slot block below verbatim. Do not alter dates, weekdays, times, or timezone labels. Do not invent calendar availability.\n" +
    slotBlock + "\n\n" +
    "Their message:\n" + body.substring(0, 1400) + "\n\n" +
    "Write ONLY the email body. Max 90 words before the sign-off. 2 short paragraphs max before slots. No bullets except the slot lines already provided. Plain text only.\n" +
    "Sign off exactly: Sarah | " + brand;
  return stripMarkdown(callClaude(user, "claude-sonnet-4-6", system));
}
function generateLeadContextualReply(body, subject, brand, name, offeredTime, slots, tzRegion, memory) {
  var target = TARGET_TZ[tzRegion] || TARGET_TZ.US;
  var calNote = "";
  if (offeredTime) {
    calNote = "Lead said they are available: " + offeredTime + "\n" +
      "If their exact time is not clearly one of the available coded slots, do not confirm it as booked. Offer the nearest coded slot or Calendly.\n";
  }
  var slotBlock = slots.length > 0 ? "Available coded slots, use verbatim if needed:\n" + slots.join("\n") : "";
  var system = buildEmailSystem(memory, brand);
  var user =
    "A lead replied. Write a helpful human response.\n\n" +
    "Brand: " + brand + " | Lead: " + (name || "there") + " | Timezone label: " + target.nice + "\n" +
    calNote + slotBlock + "\n\n" +
    "Their message:\n" + body.substring(0, 1400) + "\n\n" +
    "Move toward booking, but never claim a time is free unless it appears in the coded slots above. Calendly: " + CONFIG.CALENDLY + "\n" +
    "Max 85 words before sign-off. Max 3 short paragraphs. Plain text only. No markdown.\n" +
    "Sign off exactly: Sarah | " + brand;
  return stripMarkdown(callClaude(user, "claude-sonnet-4-6", system));
}
function generateFollowUp(data, num) {
  var tones = [
    "friendly and light, no pressure",
    "warm and concise, a little more direct",
    "brief final note, leave the door open"
  ];
  var prompt =
    "You are Sarah, client services at " + data.brand + ".\n" +
    "Follow-up #" + num + " to a lead who has not replied.\n" +
    "Tone: " + (tones[num - 1] || tones[2]) + "\n" +
    "Lead: " + (data.leadName || "there") + " | Topic: " + data.subject + "\n" +
    "Calendly: " + CONFIG.CALENDLY + "\n\n" +
    "Max 55 words. No em dashes. No bullet points. Plain text only. Sign off: Sarah | " + data.brand + "\n" +
    "Write email body only.";
  try { return stripMarkdown(callClaude(prompt, "claude-haiku-4-5-20251001")); }
  catch(e) { return "Hi, just following up on my previous email. If it is useful to compare notes, you can book here: " + CONFIG.CALENDLY + "\n\nSarah | " + data.brand; }
}
function extractOfferedTime(body) {
  var prompt = "Does this email mention a specific meeting time or availability? If yes, return it as plain text. If no, return exactly none.\n\nEmail:\n" + (body || "").substring(0, 700);
  try {
    var r = callClaude(prompt, "claude-haiku-4-5-20251001").trim();
    return (r.toLowerCase() === "none" || r.length < 4) ? null : r;
  } catch(e) { return null; }
}
function updateLeadStatus(email, status, note) {
  try {
    if (!email) return;
    var sheet = getSheet("Leads");
    var data = sheet.getDataRange().getValues();
    var map = headerMap(data[0]);
    for (var i = 1; i < data.length; i++) {
      if ((val(data[i], map, "Email") || "").toLowerCase() === email.toLowerCase()) {
        setByHeader(sheet, i + 1, map, "Status", status);
        setByHeader(sheet, i + 1, map, "LastContact", isoNow());
        if (note) setByHeader(sheet, i + 1, map, "Notes", note);
        return;
      }
    }
  } catch(e) { Logger.log("updateLeadStatus error: " + e); }
}
