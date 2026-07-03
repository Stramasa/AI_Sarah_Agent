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
  var slotsDetailed = getAvailableSlotsDetailed(tzRegion);

  var drafted = draftLeadReply({
    mode: "new",
    classification: classification,
    brand: brand,
    leadName: leadName,
    leadEmail: leadEmail,
    body: body,
    slotsDetailed: slotsDetailed,
    tzRegion: tzRegion,
    memory: memory
  });

  sendEmail({ to: leadEmail, subject: drafted.subject, body: drafted.body, bcc: CONFIG.MANAGER });

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
  var slotsDetailed = getAvailableSlotsDetailed(tzRegion);

  var drafted = draftLeadReply({
    mode: "reply",
    brand: brand,
    leadName: name,
    leadEmail: replyToEmail,
    body: body,
    slotsDetailed: slotsDetailed,
    tzRegion: tzRegion,
    offeredTime: offeredTime,
    memory: memory
  });

  sendReplyToMessage(lastMsg, drafted.body, { bcc: CONFIG.MANAGER });

  if (data.threadId) {
    data.replied = true;
    props.setProperty(key, JSON.stringify(data));
  }

  if (drafted.booking) {
    updateLeadStatus(replyToEmail, "booked", "Meeting booked: " + drafted.booking.start + " (event " + drafted.booking.eventId + ")");
    logAction(from, subject, "lead", "meeting_booked", "", replyToEmail, "Calendar invite sent for " + drafted.booking.start + ". Guests: " + drafted.booking.guests.join(", "));
    updateMemoryBrief("BOOKING", "Meeting booked for " + replyToEmail + " at " + drafted.booking.start);
  } else {
    updateLeadStatus(replyToEmail, "replied", "Lead replied. Offered time: " + (offeredTime || "none"));
    logAction(from, subject, "lead", "contextual_reply", "", replyToEmail, "Replied to lead reply");
    updateMemoryBrief("REPLY", "Lead reply handled for " + replyToEmail + ". Offered time: " + (offeredTime || "none"));
  }

  thread.markRead();
}

// ---- Single tool-use call that drafts the lead email, and books a real
// calendar invite if (and only if) the lead's message exactly confirms
// one of the offered slots. Uses the reply_to_lead / book_meeting tools
// from 10_Tool_Registry.js.
function draftLeadReply(opts) {
  var target = TARGET_TZ[opts.tzRegion] || TARGET_TZ.US;
  var system = buildEmailSystem(opts.memory, opts.brand);
  var slotLabels = opts.slotsDetailed.map(function(s) { return s.label; });

  var slotBlock = slotLabels.length > 0
    ? "Coded calendar slots, use verbatim, do not alter dates/weekdays/times/timezone labels, do not invent availability:\n" + slotLabels.join("\n") + "\n\nOr book directly: " + CONFIG.CALENDLY
    : "No open coded slots right now. Offer: " + CONFIG.CALENDLY;

  var userPrompt;
  var tools;
  var toolChoice = "any";

  if (opts.mode === "new") {
    tools = [LEAD_TOOLS[0]]; // reply_to_lead only - never book on first contact
    userPrompt =
      "Write the first reply to this inbound lead using the reply_to_lead tool.\n\n" +
      "Brand: " + opts.brand + "\nLead name: " + (opts.leadName || "there") +
      "\nInterest: " + (opts.classification.service_interest || "their inquiry") +
      "\nExternal timezone label to use: " + target.nice + "\n\n" +
      slotBlock + "\n\n" +
      "Their message:\n" + opts.body.substring(0, 1400) + "\n\n" +
      "Max 90 words before the sign-off. 2 short paragraphs max before slots.";
  } else {
    tools = LEAD_TOOLS; // reply_to_lead + book_meeting
    var calNote = opts.offeredTime
      ? "Lead mentioned availability: \"" + opts.offeredTime + "\". Match this against the coded slots below. If it clearly maps to one of them, confirm and call book_meeting. If it is vague (e.g. 'next week', 'mornings', a range) or doesn't match a coded slot exactly, just reply offering the slots below.\n"
      : "Lead has NOT confirmed a specific slot yet. Just reply with the available slots and invite them to pick one. Do NOT call book_meeting.\n";

    userPrompt =
      "A lead replied. Write a helpful response using the reply_to_lead tool.\n\n" +
      "Brand: " + opts.brand + " | Lead: " + (opts.leadName || "there") + " | Timezone label: " + target.nice + "\n" +
      calNote + slotBlock + "\n\n" +
      "Their message:\n" + opts.body.substring(0, 1400) + "\n\n" +
      "Keep it warm and brief. Only call book_meeting if the lead has clearly confirmed one of the exact coded slots above — not for vague availability or general availability offers. " +
      "Max 85 words before sign-off. Max 3 short paragraphs.";
  }

  var fallback = {
    subject: "Following up | " + opts.brand,
    body: "Hi " + (opts.leadName || "there") + ",\n\nThanks for reaching out. You can book a time directly here: " + CONFIG.CALENDLY + "\n\nSarah | " + opts.brand,
    booking: null
  };

  try {
    var result = callClaudeTools(userPrompt, tools, system, "claude-sonnet-4-6", toolChoice);

    var replyCall = result.toolCalls.filter(function(c) { return c.name === "reply_to_lead"; })[0];
    var bookCall = result.toolCalls.filter(function(c) { return c.name === "book_meeting"; })[0];

    if (!replyCall || !replyCall.input || !replyCall.input.body) {
      throw new Error("reply_to_lead tool did not return usable input");
    }

    var out = {
      subject: stripMarkdown(replyCall.input.subject || fallback.subject),
      body: stripMarkdown(replyCall.input.body),
      booking: null
    };

    if (bookCall && bookCall.input && bookCall.input.chosen_slot) {
      var matchedSlot = findSlotByLabel(opts.slotsDetailed, bookCall.input.chosen_slot);

      if (!matchedSlot) {
        Logger.log("BOOKING SKIPPED: chosen_slot '" + bookCall.input.chosen_slot + "' did not match any offered slot for " + opts.leadEmail);
      } else {
        try {
          var meetingTitle = bookCall.input.meeting_title || (opts.brand + " Intro Call - " + (opts.leadName || opts.leadEmail));
          out.booking = createLeadMeeting(matchedSlot, meetingTitle, opts.leadEmail);
        } catch (bookErr) {
          Logger.log("BOOKING ERROR for " + opts.leadEmail + ": " + bookErr);
        }
      }
    }

    return out;
  } catch (e) {
    Logger.log("draftLeadReply error: " + e);
    return fallback;
  }
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
  var prompt =
    "Does this email confirm a SPECIFIC meeting time with a real date and clock time (e.g. 'Tuesday at 3pm', 'July 8 at 10am ET')? " +
    "If yes, return it as plain text. " +
    "If the email only mentions a vague availability like 'next week', 'mornings', 'anytime', or asks for your availability, return exactly: none\n\n" +
    "Email:\n" + (body || "").substring(0, 700);
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