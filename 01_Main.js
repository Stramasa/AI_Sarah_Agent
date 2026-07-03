function checkLeads() {
  Logger.log("=== checkLeads START ===");
  ensureAllSheets();

  var instructions = loadInstructions();
  var knowledge = loadKnowledge();
  var sessionLog = [];
  var processedLabel = getOrCreateLabel(CONFIG.LABEL_PROCESSED);

  rescueForwardedLeadsFromSpam();

  // Search unread + threads manually flagged for reprocessing (label:SarahNeedsReview).
  // If you already read an email in Gmail before the trigger fires, add
  // label SarahNeedsReview to it and run checkLeads again.
  var threads = GmailApp.search(
    "(is:unread OR label:SarahNeedsReview) -label:" + CONFIG.LABEL_PROCESSED,
    0, 25
  );
  var reprocessLabel = GmailApp.getUserLabelByName("SarahNeedsReview");

  Logger.log("THREADS FOUND: " + threads.length);
  if (threads.length === 0) return;

  threads.forEach(function(thread) {
    if (reprocessLabel) thread.removeLabel(reprocessLabel);

    var messages = thread.getMessages();
    var activeMsg = messages[messages.length - 1];
    var subject = activeMsg.getSubject() || "";
    var from = activeMsg.getFrom() || "";
    var to = activeMsg.getTo() || "";
    var activeBody = activeMsg.getPlainBody() || "";
    var threadId = thread.getId();
    var fromEmail = extractEmail(from);

    Logger.log("--- THREAD: " + subject + " | from=" + from + " | msgs=" + messages.length);

    // If the last message is from Sarah (she already replied), look backwards for
    // the most recent external lead message. This handles SarahNeedsReview
    // re-runs and cases where a fallback reply was sent instead of a real one.
    if (fromEmail === CONFIG.FROM_EMAIL) {
      var foundLeadMsg = false;
      for (var mi = messages.length - 2; mi >= 0; mi--) {
        var miEmail = extractEmail(messages[mi].getFrom() || "");
        if (miEmail !== CONFIG.FROM_EMAIL && !isInternalEmail(miEmail)) {
          activeMsg = messages[mi];
          from = messages[mi].getFrom() || "";
          fromEmail = miEmail;
          activeBody = messages[mi].getPlainBody() || "";
          Logger.log("Last msg was Sarah — using prior lead message from: " + from);
          foundLeadMsg = true;
          break;
        }
      }
      if (!foundLeadMsg) {
        logAction(from, subject, "skipped", "sarah_last_sender", "", "",
          fromEmail, "Skipped: Sarah is the last sender, no prior external message found.");
        thread.addLabel(processedLabel);
        thread.markRead();
        return;
      }
    }

    if (isBounceEmail(subject, activeBody, from)) {
      handleBounceEmail(thread, subject, activeBody, from);
      sessionLog.push("Bounce flagged to manager: " + subject);
      thread.addLabel(processedLabel);
      return;
    }

    if (isCalendlyConfirmation(subject, from, activeBody)) {
      handleCalendlyConfirmation(thread, subject, activeBody, from);
      sessionLog.push("Calendly confirmation logged: " + subject);
      thread.addLabel(processedLabel);
      return;
    }

    // ---- Determine the real external party --------------------------------
    // For known form forwarders (requests@, groupleads@) and internal team
    // members (pepijn@, sang@, eimee@), extract the real external sender from
    // the email body rather than using the forwarder's own address.
    var classifyFrom = from;
    var classifyEmail = fromEmail;
    var isForwardedByTeam = false;
    var forwardedByEmail = "";

    if (isKnownForwarder(fromEmail) || isInternalForwarder(fromEmail)) {
      Logger.log("Detected forward from: " + fromEmail);
      isForwardedByTeam = isInternalForwarder(fromEmail);
      forwardedByEmail = fromEmail;

      var realSender = analyzeEmailSender(subject, activeBody, from);
      if (realSender && realSender.replyTo && !isInternalEmail(realSender.replyTo)) {
        classifyEmail = realSender.replyTo;
        classifyFrom = realSender.replyTo;
        Logger.log("Extracted real sender: " + classifyEmail);
      } else {
        Logger.log("Could not extract external sender — will treat as internal coordination");
      }
    }

    // ---- Pre-classify: known client directory match -----------------------
    var possibleClient = findClientInDirectorySmart(classifyEmail, subject, activeBody);

    if (possibleClient) {
      Logger.log("PRE-CLASSIFY: matched known client — " + possibleClient.clientName);

      // Known clients always go through handleClientEmail (internal tracking + team notification).
      // We never send external scheduling emails to existing clients — that must come from the
      // account manager directly, not from Sarah's automation.
      try {
        handleClientEmail(thread, activeMsg, buildSarahContext("client", activeBody, instructions, knowledge));
        sessionLog.push("Known client email processed: " + subject);
        logAction(from, subject, "client", "pre_classify_client_match",
          possibleClient.clientName || "", "Matched Client Directory before Claude classification.",
          possibleClient.email || classifyEmail, "Known client match.");
      } catch(e) {
        Logger.log("ERROR handleClientEmail pre-classify: " + e);
        handleUnsureEmail(thread, subject, activeBody, from, "Known client match but handler failed: " + e);
        logAction(from, subject, "client", "error_escalated",
          possibleClient.clientName || "", "Handler failed after client match.",
          possibleClient.email || classifyEmail, String(e));
      }

      thread.addLabel(processedLabel);
      return;
    }

    // ---- Claude classification -------------------------------------------
    var classification = safeClassify(subject, activeBody, classifyFrom, instructions);
    Logger.log("CLASSIFIED: " + JSON.stringify(classification));

    // If a team member forwarded this email, trust that it needs a response —
    // never silently discard it as spam or talent.
    if (isForwardedByTeam) {
      if (classification.type === "spam" || classification.type === "talent") {
        Logger.log("OVERRIDE: team-forwarded email re-classified from " + classification.type + " to lead");
        classification.type = "lead";
        classification.reason = "Team-forwarded — overriding " + classification.type + " classification.";
      }
    }

    if (classification.type === "spam") {
      thread.addLabel(getOrCreateLabel(CONFIG.LABEL_SPAM));
      thread.addLabel(processedLabel);
      thread.markRead();
      logAction(from, subject, "spam", "skipped", "", "Spam/system email skipped.", classifyEmail, classification.reason || "");
      return;
    }

    if (classification.type === "talent") {
      thread.addLabel(getOrCreateLabel(CONFIG.LABEL_TALENT));
      thread.addLabel(processedLabel);
      thread.markRead();
      logAction(from, subject, "talent", "labeled", "", "Talent/applicant email ignored.", classifyEmail, classification.reason || "");
      return;
    }

    var brand = detectBrand(subject + " " + activeBody + " " + to);
    var props = PropertiesService.getScriptProperties();
    var hasLeadRecord = props.getProperty(CONFIG.PROP_PREFIX + threadId) !== null;

    logAction(from, subject, classification.type, "pending", "", "", classifyEmail, classification.reason || "");

    try {
      if (messages.length > 1 && hasLeadRecord) {
        // Existing lead replied to a previous Sarah message.
        handleLeadReply(thread, buildSarahContext("lead", activeBody, instructions, knowledge));
        sessionLog.push("Known lead reply handled: " + subject);

      } else if (classification.type === "lead") {
        handleNewLead(
          thread, activeMsg, classification, brand,
          buildSarahContext("lead", activeBody, instructions, knowledge),
          isForwardedByTeam ? forwardedByEmail : null
        );
        sessionLog.push("New lead replied to: " + subject);

      } else if (classification.type === "client") {
        // Client emails always go to handleClientEmail for internal tracking.
        // Sarah never sends external scheduling emails to existing clients.
        handleClientEmail(thread, activeMsg, buildSarahContext("client", activeBody, instructions, knowledge));
        sessionLog.push("Client/PM email processed: " + subject);

      } else {
        handleUnsureEmail(thread, subject, activeBody, from, "Classification unsure");
        sessionLog.push("Unsure email escalated: " + subject);
        logAction(from, subject, "unsure", "manager_alerted", "",
          "Classification unsure. Escalated to manager.", classifyEmail, classification.reason || "");
      }
    } catch(e) {
      Logger.log("ERROR in handler: " + e);
      handleUnsureEmail(thread, subject, activeBody, from, "Script error: " + e);
      sessionLog.push("Error escalated: " + subject + " | " + e);
      logAction(from, subject, classification.type || "unknown", "error_escalated",
        "", "Script error during handler.", classifyEmail, String(e));
    }

    thread.addLabel(processedLabel);
  });

  maybeLearnFromSession(sessionLog, buildSarahContext("learning", sessionLog.join("\n"), instructions, knowledge));

  Logger.log("=== checkLeads END ===");
}

// Handles team-forwarded emails where Sarah needs to reply to an external
// party with calendar slots (scheduling coordination, re-engagement, etc.).
// Sarah replies to the external contact and BCCs the team member who forwarded.
function handleSchedulingForward(thread, msg, classification, brand, externalEmail, memory, forwardedByEmail) {
  var subject = msg.getSubject() || "";
  var body = msg.getPlainBody() || "";

  var senderInfo = analyzeEmailSender(subject, body, msg.getFrom() || "");
  var leadEmail = (senderInfo && senderInfo.replyTo && !isInternalEmail(senderInfo.replyTo))
    ? senderInfo.replyTo
    : externalEmail;
  var leadName = (senderInfo && senderInfo.name) || classification.name || "";

  if (!leadEmail) {
    handleUnsureEmail(thread, subject, body, msg.getFrom() || "",
      "Team forward: could not determine external email to reply to");
    return;
  }

  var tzRegion = detectTimezoneRegion(body + " " + leadEmail);
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

  sendEmail({ to: leadEmail, subject: drafted.subject, body: drafted.body, bcc: bccList.join(",") });

  thread.addLabel(getOrCreateLabel(CONFIG.LABEL_LEAD));
  thread.markRead();

  logAction(msg.getFrom() || "", subject, "lead", "scheduling_forward_replied",
    "", leadEmail, "Replied to external contact from team-forwarded email. BCC: " + bccList.join(", "));
  updateMemoryBrief("FORWARD",
    "Team-forwarded email handled for " + leadEmail + " (forwarded by " + forwardedByEmail + ")");
}

function isKnownForwarder(email) {
  var needle = (email || "").toLowerCase().trim();
  if (!needle) return false;
  return CONFIG.FORWARDERS.some(function(f) {
    return String(f || "").toLowerCase().trim() === needle;
  });
}

function isInternalForwarder(email) {
  var needle = (email || "").toLowerCase().trim();
  if (!needle) return false;
  return (CONFIG.INTERNAL_TEAM || []).some(function(f) {
    return String(f || "").toLowerCase().trim() === needle;
  });
}

// ---- Debug: shows exactly what checkLeads sees and would do, without
// sending any emails or changing any data. Run from the editor and check
// the Execution Log / Logger output.
function debugCheckLeads() {
  Logger.log("=== debugCheckLeads START ===");

  var threads = GmailApp.search(
    "(is:unread OR label:SarahNeedsReview) -label:" + CONFIG.LABEL_PROCESSED,
    0, 25
  );
  Logger.log("Threads found: " + threads.length);

  threads.forEach(function(thread) {
    var messages = thread.getMessages();
    var activeMsg = messages[messages.length - 1];
    var subject = activeMsg.getSubject() || "";
    var from = activeMsg.getFrom() || "";
    var activeBody = activeMsg.getPlainBody() || "";
    var fromEmail = extractEmail(from);

    Logger.log("THREAD: " + subject);
    Logger.log("  from=" + from + " | msgs=" + messages.length + " | unread=" + thread.isUnread());

    if (fromEmail === CONFIG.FROM_EMAIL) {
      Logger.log("  ACTION: skip (Sarah's own sent email)");
      return;
    }

    if (isBounceEmail(subject, activeBody, from)) {
      Logger.log("  ACTION: handle as bounce");
      return;
    }

    if (isCalendlyConfirmation(subject, from, activeBody)) {
      Logger.log("  ACTION: log Calendly confirmation");
      return;
    }

    var isForwarder = isKnownForwarder(fromEmail);
    var isTeamFwd = isInternalForwarder(fromEmail);
    Logger.log("  isKnownForwarder=" + isForwarder + " | isInternalForwarder=" + isTeamFwd);

    var classifyFrom = from;
    var classifyEmail = fromEmail;

    if (isForwarder || isTeamFwd) {
      var realSender = analyzeEmailSender(subject, activeBody, from);
      Logger.log("  Real sender: " + JSON.stringify(realSender));
      if (realSender && realSender.replyTo && !isInternalEmail(realSender.replyTo)) {
        classifyFrom = realSender.replyTo;
        classifyEmail = realSender.replyTo;
      }
    }

    var possibleClient = findClientInDirectorySmart(classifyEmail, subject, activeBody);
    if (possibleClient) {
      var schedFlag = isTeamFwd && looksLikeSchedulingRequest(activeBody);
      Logger.log("  Client directory match: " + possibleClient.clientName +
        " | ACTION: " + (schedFlag ? "handleSchedulingForward" : "handleClientEmail"));
      return;
    }

    var classification = safeClassify(subject, activeBody, classifyFrom, "");
    var finalType = classification.type;

    if (isTeamFwd && (finalType === "spam" || finalType === "talent")) {
      Logger.log("  OVERRIDE: team-forward, reclassifying " + finalType + " -> lead");
      finalType = "lead";
    }

    Logger.log("  Classification: " + finalType + " | reason: " + (classification.reason || ""));

    var props = PropertiesService.getScriptProperties();
    var hasLeadRecord = props.getProperty(CONFIG.PROP_PREFIX + thread.getId()) !== null;

    if (finalType === "spam")   Logger.log("  ACTION: label as spam, skip");
    else if (finalType === "talent") Logger.log("  ACTION: label as talent, skip");
    else if (messages.length > 1 && hasLeadRecord) Logger.log("  ACTION: handleLeadReply");
    else if (finalType === "lead")   Logger.log("  ACTION: handleNewLead -> reply with calendar slots");
    else if (finalType === "client" && isTeamFwd) Logger.log("  ACTION: handleSchedulingForward -> reply with slots");
    else if (finalType === "client") Logger.log("  ACTION: handleClientEmail -> internal tracking only");
    else Logger.log("  ACTION: handleUnsureEmail -> forward to manager");
  });

  Logger.log("=== debugCheckLeads END ===");
}

function processFollowUps() {
  Logger.log("=== processFollowUps START ===");
  ensureAllSheets();

  var props = PropertiesService.getScriptProperties();
  var keys = props.getKeys().filter(function(k) {
    return k.indexOf(CONFIG.PROP_PREFIX) === 0;
  });

  var now = new Date().getTime();

  keys.forEach(function(key) {
    var data = JSON.parse(props.getProperty(key) || "{}");

    if (!data.leadEmail || data.replied || data.followUpCount >= 3) {
      props.deleteProperty(key);
      return;
    }

    var hoursSince = (now - data.sentAt) / 3600000;
    var thresholds = [CONFIG.FOLLOW_UP_1_HOURS, CONFIG.FOLLOW_UP_2_HOURS, CONFIG.FOLLOW_UP_3_HOURS];

    if (hoursSince < thresholds[data.followUpCount]) return;

    var num = data.followUpCount + 1;
    var body = generateFollowUp(data, num);

    var repliedInThread = false;
    try {
      var followThread = GmailApp.getThreadById(data.threadId);
      var followMsgs = followThread ? followThread.getMessages() : null;
      if (followMsgs && followMsgs.length > 0) {
        sendReplyToMessage(followMsgs[followMsgs.length - 1], body, { bcc: CONFIG.MANAGER });
        repliedInThread = true;
      }
    } catch (threadErr) {
      Logger.log("Follow-up reply-in-thread failed for " + data.leadEmail + ": " + threadErr);
    }

    if (!repliedInThread) {
      sendEmail({
        to: data.leadEmail,
        subject: subjectWithRe(data.subject),
        body: body,
        bcc: CONFIG.MANAGER
      });
    }

    logAction(data.leadEmail, data.subject, "lead", "followup_" + num,
      "", "Follow-up sent.", data.leadEmail, "Lead had not replied after follow-up threshold.");

    data.followUpCount = num;
    data.sentAt = now;

    if (data.followUpCount >= 3) {
      props.deleteProperty(key);
      updateLeadStatus(data.leadEmail, "no-reply-3-followups", "Closed after 3 follow-ups");
    } else {
      props.setProperty(key, JSON.stringify(data));
    }
  });

  Logger.log("=== processFollowUps END ===");
}
