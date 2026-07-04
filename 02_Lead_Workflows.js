function handleNewLead(thread, msg, classification, brand, memory, forwardedByEmail) {
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

  var bccList = [CONFIG.MANAGER];
  if (forwardedByEmail && forwardedByEmail !== CONFIG.MANAGER) bccList.push(forwardedByEmail);

  if (forwardedByEmail) {
    // Forwarded lead: Sarah is starting a fresh conversation with the external
    // person who never emailed sarah directly, so a new email is correct.
    sendEmail({ to: leadEmail, subject: drafted.subject, body: drafted.body, bcc: bccList.join(",") });
  } else {
    // Direct inbound email: reply in-thread so the lead's next reply lands in
    // the same thread and hasLeadRecord matching works correctly.
    sendReplyToMessage(msg, drafted.body, { bcc: bccList.join(",") });
  }

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
    JSON.stringify({
      threadId: threadId,
      leadEmail: leadEmail,
      leadName: leadName,
      subject: subject,
      brand: brand,
      sentAt: new Date().getTime(),
      followUpCount: 0,
      replied: false
    })
  );

  thread.addLabel(getOrCreateLabel(CONFIG.LABEL_LEAD));
  thread.addLabel(getOrCreateLabel(CONFIG.LABEL_FOLLOWUP));
  thread.markRead();

  updateMemoryBrief("LEAD", "New lead " + leadName + " <" + leadEmail + "> for " + brand + ": " + (classification.service_interest || "unspecified service"));
  logAction(from, subject, "lead", "replied", "", leadEmail, "Initial reply sent with coded calendar slots");
}

function handleLeadReply(thread, memory) {
  var messages = thread.getMessages();
  var threadId = thread.getId();

  // Find the last message from the external lead — not Sarah, not internal team.
  // This handles cases where Sarah's own reply is the most recent message.
  var lastMsg = null;
  for (var i = messages.length - 1; i >= 0; i--) {
    var mEmail = extractEmail(messages[i].getFrom() || "");
    if (mEmail !== CONFIG.FROM_EMAIL && !isInternalEmail(mEmail)) {
      lastMsg = messages[i];
      break;
    }
  }
  if (!lastMsg) {
    Logger.log("handleLeadReply: no external lead message in thread " + threadId + ", skipping");
    return;
  }

  var from = lastMsg.getFrom() || "";
  var body = lastMsg.getPlainBody() || "";
  var subject = lastMsg.getSubject() || "";

  var props = PropertiesService.getScriptProperties();
  var key = CONFIG.PROP_PREFIX + threadId;
  var data = JSON.parse(props.getProperty(key) || "{}");
  var replyToEmail = data.leadEmail || extractEmail(from);
  var brand = data.brand || DEFAULT_BRAND;
  var name = data.leadName || "";
  var tzRegion = detectTimezoneRegion(body + " " + from + " " + replyToEmail);
  var offeredTime = extractOfferedTime(body);
  var slotsDetailed = getAvailableSlotsDetailed(tzRegion);

  // Build thread context so Claude can see the full conversation when the
  // lead says something like "I agree with the proposal" or "Tuesday works" —
  // without this context Claude can't know what was previously offered.
  var threadContext = buildThreadContext(messages);

  var drafted;
  try {
    drafted = draftLeadReply({
      mode: "reply",
      brand: brand,
      leadName: name,
      leadEmail: replyToEmail,
      body: body,
      threadContext: threadContext,
      slotsDetailed: slotsDetailed,
      tzRegion: tzRegion,
      offeredTime: offeredTime,
      memory: memory
    });
  } catch(draftErr) {
    Logger.log("handleLeadReply: draftLeadReply failed for " + replyToEmail + ": " + draftErr);
    // Escalate to the team — do NOT send a generic fallback to the lead.
    sendEmail({
      to: CONFIG.ESCALATION_TO,
      cc: CONFIG.ESCALATION_CC,
      subject: "Sarah needs help with lead reply: " + subject,
      body: "Hi,\n\nSarah could not process this lead reply automatically. Please handle it manually.\n\n" +
            "Lead: " + replyToEmail + "\nSubject: " + subject + "\n\nTheir message:\n" +
            body.substring(0, 800) + "\n\nSarah"
    });
    logAction(from, subject, "lead", "escalated_draft_failed", "", replyToEmail,
      "draftLeadReply failed: " + draftErr);
    thread.markRead();
    return;
  }

  sendReplyToMessage(lastMsg, drafted.body, { bcc: CONFIG.MANAGER });

  if (data.threadId) {
    data.replied = true;
    data.replyCount = (data.replyCount || 0) + 1;
    props.setProperty(key, JSON.stringify(data));
  }

  // After LEAD_ESCALATE_AFTER_ROUNDS back-and-forths with no booking,
  // quietly notify Pepijn + Sang so a human can decide whether to step in.
  var replyCount = data.replyCount || 1;
  var threshold = CONFIG.LEAD_ESCALATE_AFTER_ROUNDS || 3;
  if (!drafted.booking && replyCount >= threshold) {
    try {
      sendEmail({
        to: CONFIG.ESCALATION_TO,
        cc: CONFIG.ESCALATION_CC,
        subject: "Lead update (" + replyCount + " rounds): " + subject,
        body: "Hi,\n\nThis lead has gone back and forth " + replyCount + " times without booking a meeting. You may want to review or take over.\n\n" +
              "Lead: " + replyToEmail + "\nSubject: " + subject + "\n\nLatest message:\n" + body.substring(0, 800) + "\n\nSarah"
      });
      logAction(from, subject, "lead", "escalated_to_team",
        "", replyToEmail, "Escalated after " + replyCount + " rounds with no booking.");
    } catch(escalErr) {
      Logger.log("Escalation notify error: " + escalErr);
    }
  }

  if (drafted.booking) {
    updateLeadStatus(replyToEmail, "booked", "Meeting booked: " + drafted.booking.start + " (event " + drafted.booking.eventId + ")");
    logAction(from, subject, "lead", "meeting_booked", "", replyToEmail,
      "Calendar invite sent for " + drafted.booking.start + ". Guests: " + drafted.booking.guests.join(", "));
    updateMemoryBrief("BOOKING", "Meeting booked for " + replyToEmail + " at " + drafted.booking.start);
    try { thread.removeLabel(getOrCreateLabel(CONFIG.LABEL_FOLLOWUP)); } catch(le) {}
  } else {
    updateLeadStatus(replyToEmail, "replied", "Lead replied. Offered time: " + (offeredTime || "none"));
    logAction(from, subject, "lead", "contextual_reply", "", replyToEmail, "Replied to lead reply");
    updateMemoryBrief("REPLY", "Lead reply handled for " + replyToEmail + ". Offered time: " + (offeredTime || "none"));
  }

  thread.markRead();
}

// Returns the last few messages of a thread as plain text, newest last,
// so Claude has conversation context when processing a lead reply.
function buildThreadContext(messages) {
  var take = Math.min(messages.length, 4);
  var parts = [];
  for (var i = messages.length - take; i < messages.length - 1; i++) {
    var m = messages[i];
    var mFrom = m.getFrom() || "";
    var mBody = (m.getPlainBody() || "").substring(0, 600);
    parts.push("[" + mFrom + "]\n" + mBody);
  }
  return parts.join("\n\n---\n\n");
}

// ---- Single tool-use call that drafts the lead email, and books a real
// calendar invite if the lead confirms a slot. Uses the reply_to_lead /
// book_meeting tools from 10_Tool_Registry.js.
function draftLeadReply(opts) {
  var target = TARGET_TZ[opts.tzRegion] || TARGET_TZ.US;
  var system = buildEmailSystem(opts.memory, opts.brand);
  var slotLabels = opts.slotsDetailed.map(function(s) { return s.label; });

  var slotBlock = slotLabels.length > 0
    ? "Available slots (use verbatim, do not alter):\n" + slotLabels.join("\n") + "\n\nOr book directly: " + CONFIG.CALENDLY
    : "No open slots right now. Offer: " + CONFIG.CALENDLY;

  var userPrompt;
  var tools;
  // For new leads: force reply_to_lead (never book on first contact).
  // For replies: also force reply_to_lead — Claude may additionally call
  // book_meeting in the same turn, but a reply email is always required.
  var toolChoice = { type: "tool", name: "reply_to_lead" };

  if (opts.mode === "new") {
    tools = [LEAD_TOOLS[0]]; // reply_to_lead only — never book on first contact
    userPrompt =
      "Write the first reply to this inbound lead using the reply_to_lead tool.\n\n" +
      "Brand: " + opts.brand + "\nLead name: " + (opts.leadName || "there") +
      "\nInterest: " + (opts.classification.service_interest || "their inquiry") +
      "\nTimezone to use: " + target.nice + "\n\n" +
      slotBlock + "\n\n" +
      "Their message:\n" + opts.body.substring(0, 1400) + "\n\n" +
      "Max 90 words before the sign-off. 2 short paragraphs max before slots.";

  } else {
    tools = LEAD_TOOLS; // reply_to_lead + book_meeting

    var contextBlock = opts.threadContext
      ? "Conversation so far (oldest first):\n" + opts.threadContext + "\n\n"
      : "";

    var bookingInstruction;
    if (opts.offeredTime) {
      bookingInstruction =
        "Lead mentioned: \"" + opts.offeredTime + "\".\n" +
        "If this maps to one of the coded slots (same day, close enough time), call book_meeting with that slot.\n" +
        "If it is genuinely vague (e.g. 'mornings', 'next week', a day range), just offer the slots again.\n";
    } else {
      // No specific time — but check for booking intent words like "I agree",
      // "send me the invite", "let's do it", "confirmed", "that works for me".
      bookingInstruction =
        "Lead has not specified an exact time. HOWEVER: if the lead clearly agrees to one of the slots " +
        "previously offered in this conversation (e.g. says 'I agree', 'that works', 'send the invite', " +
        "'confirmed', 'let's do it', 'sounds good') — pick the slot they were most recently offered and " +
        "call book_meeting for it. If the intent is genuinely ambiguous, just offer the slots again.\n";
    }

    userPrompt =
      "A lead replied. Write a helpful response using the reply_to_lead tool.\n\n" +
      "Brand: " + opts.brand + " | Lead: " + (opts.leadName || "there") + " | Timezone: " + target.nice + "\n\n" +
      contextBlock +
      bookingInstruction + "\n" +
      slotBlock + "\n\n" +
      "Their latest message:\n" + opts.body.substring(0, 1400) + "\n\n" +
      "Keep it warm and brief. Max 85 words before sign-off. " +
      "IMPORTANT: if the lead mentions a colleague's email address and asks to include them, " +
      "add it to additional_guests in the book_meeting call.";
  }

  try {
    var result = callClaudeTools(userPrompt, tools, system, "claude-sonnet-4-6", toolChoice);

    var replyCall = result.toolCalls.filter(function(c) { return c.name === "reply_to_lead"; })[0];
    var bookCall  = result.toolCalls.filter(function(c) { return c.name === "book_meeting"; })[0];

    if (!replyCall || !replyCall.input || !replyCall.input.body) {
      throw new Error("reply_to_lead tool did not return usable input");
    }

    var out = {
      subject: stripMarkdown(replyCall.input.subject || ("Re: " + (opts.leadName || ""))),
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
          var extraGuests = bookCall.input.additional_guests || [];
          out.booking = createLeadMeeting(matchedSlot, meetingTitle, opts.leadEmail, extraGuests);
        } catch (bookErr) {
          Logger.log("BOOKING ERROR for " + opts.leadEmail + ": " + bookErr);
        }
      }
    }

    return out;
  } catch (e) {
    Logger.log("draftLeadReply error: " + e);
    throw e;
  }
}

function generateFollowUp(data, num) {
  var tones = [
    "friendly and light, no pressure",
    "warm and concise, a little more direct",
    "brief final note, leave the door open"
  ];

  // Get fresh available slots for this lead's timezone.
  var tzRegion = detectTimezoneRegion((data.leadEmail || "") + " " + (data.subject || ""));
  var slotsDetailed = [];
  try { slotsDetailed = getAvailableSlotsDetailed(tzRegion); } catch(e) {}
  var slotLabels = slotsDetailed.map(function(s) { return s.label; });
  var slotBlock = slotLabels.length > 0
    ? "\n\nHere are a few times that still work:\n" + slotLabels.join("\n") + "\n\nOr book directly: " + CONFIG.CALENDLY
    : "\n\nYou can also book directly here: " + CONFIG.CALENDLY;

  var prompt =
    "You are Sarah, client services at " + data.brand + ".\n" +
    "Write follow-up #" + num + " to a lead who has not replied to your first email.\n" +
    "Tone: " + (tones[num - 1] || tones[2]) + "\n" +
    "Lead: " + (data.leadName || "there") + " | Topic: " + data.subject + "\n\n" +
    "Max 45 words. No em dashes. No bullet points. Plain text only.\n" +
    "Sign off: Sarah | " + data.brand + "\n" +
    "Do NOT include calendar slots or a Calendly link in your text — they are appended automatically.\n" +
    "Write the email body only (warm opening paragraph + sign-off).";

  try {
    return stripMarkdown(callClaude(prompt, "claude-haiku-4-5-20251001")) + slotBlock;
  } catch(e) {
    return "Hi " + (data.leadName || "there") + ",\n\nJust following up to make sure my previous email didn't get lost." +
      slotBlock + "\n\nSarah | " + data.brand;
  }
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
