function checkLeads() {
  Logger.log("=== checkLeads START ===");
  ensureAllSheets();

  var instructions = loadInstructions();
  var knowledge = loadKnowledge();
  var sessionLog = [];
  var processedLabel = getOrCreateLabel(CONFIG.LABEL_PROCESSED);

  rescueForwardedLeadsFromSpam();

  // Search unread AND threads explicitly flagged for reprocessing.
  // This means even if you read an email in Gmail before the trigger fires,
  // you can add label SarahNeedsReview to force it through.
  var threads = GmailApp.search(
    "(is:unread OR label:SarahNeedsReview) -label:" + CONFIG.LABEL_PROCESSED,
    0, 25
  );

  // Remove SarahNeedsReview label once picked up so it doesn't loop.
  var reprocessLabel = GmailApp.getUserLabelByName("SarahNeedsReview");

  Logger.log("THREADS FOUND: " + threads.length);
  if (threads.length === 0) return;

  threads.forEach(function(thread) {
    // Remove reprocess label immediately so it doesn't trigger again.
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

    // Skip emails Sarah herself sent.
    if (fromEmail === CONFIG.FROM_EMAIL) {
      thread.addLabel(processedLabel);
      thread.markRead();
      return;
    }

    if (isBounceEmail(subject, activeBody, from)) {
      handleBounceEmail(thread, subject, activeBody, from);
      sessionLog.push("Bounce flagged to manager: " + subject);
      thread.addLabel(processedLabel);
      return;
    }

    if (isCalendlyConfirmation(subject, from, activeBody)) {
      handleCalendlyConfirmation(thread, subject, activeBody, from);
      sessionLog.push("Calendly confirmation logged without reply: " + subject);
      thread.addLabel(processedLabel);
      return;
    }

    // Determine the real external party this email is about.
    // For known forwarders (requests@, groupleads@) and internal team forwards
    // (pepijn@, sang@, eimee@), extract the real sender from the body.
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
        Logger.log("Could not extract external sender from forward body — treating as internal coordination");
      }
    }

    var possibleClient = findClientInDirectorySmart(classifyEmail, subject, activeBody);

    if (possibleClient) {
      Logger.log("PRE-CLASSIFY: matched known client, routing to client workflow");

      try {
        // If a team member forwarded this and the external party wants to schedule
        // a meeting, reply with calendar slots rather than just logging internally.
        if (isForwardedByTeam && looksLikeSchedulingRequest(activeBody)) {
          handleSchedulingForward(
            thread, activeMsg,
            { type: "client", name: possibleClient.clientName || "", service_interest: "" },
            detectBrand(subject + " " + activeBody),
            classifyEmail,
            buildSarahContext("lead", activeBody, instructions, knowledge),
            forwardedByEmail
          );
          sessionLog.push("Team-forwarded scheduling request (known client) handled: " + subject);
        } else {
          handleClientEmail(thread, activeMsg, buildSarahContext("client", activeBody, instructions, knowledge));
          sessionLog.push("Known client email processed: " + subject);
        }

        logAction(from, subject, "client", "pre_classify_client_match",
          possibleClient.clientName || "", "Matched Client Directory before Claude classification.",
          possibleClient.email || classifyEmail, "Known client match found in Client Directory.");
      } catch(e) {
        Logger.log("ERROR handleClientEmail pre-classify: " + e);
        handleUnsureEmail(thread, subject, activeBody, from, "Known client match but client handler failed: " + e);
        logAction(from, subject, "client", "error_escalated",
          possibleClient.clientName || "", "Known client match but handler failed.",
          possibleClient.email || classifyEmail, String(e));
      }

      thread.addLabel(processedLabel);
      return;
    }

    var classification = safeClassify(subject, activeBody, classifyFrom);
    Logger.log("CLASSIFIED: " + JSON.stringify(classification));

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
      logAction(from, subject, "talent", "labeled", "", "Talent/applicant email ignored unless hiring request.", classifyEmail, classification.reason || "Classified as talent/application.");
      return;
    }

    var brand = detectBrand(subject + " " + activeBody + " " + to);
    var props = PropertiesService.getScriptProperties();
    var hasLeadRecord = props.getProperty(CONFIG.PROP_PREFIX + threadId) !== null;

    logAction(from, subject, classification.type, "pending", "", "", classifyEmail, classification.reason || "");

    try {
      if (messages.length > 1 && hasLeadRecord) {
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
        // A "client" classification on a team-forwarded email may actually
        // be a scheduling coordination request (e.g. Pepijn forwarding Nico's
        // "can we meet next week?" email). Handle it as a lead-style scheduling
        // reply so Sarah actually responds to the external party with times.
        if (isForwardedByTeam && classifyEmail !== fromEmail) {
          handleSchedulingForward(
            thread, activeMsg, classification, brand, classifyEmail,
            buildSarahContext("lead", activeBody, instructions, knowledge),
            forwardedByEmail
          );
          sessionLog.push("Team-forwarded scheduling request handled: " + subject);
        } else {
          handleClientEmail(thread, activeMsg, buildSarahContext("client", activeBody, instructions, knowledge));
          sessionLog.push("Client/PM email processed: " + subject);
        }

      } else {
        handleUnsureEmail(thread, subject, activeBody, from, "Classification unsure");
        sessionLog.push("Unsure email escalated: " + subject);
        logAction(from, subject, "unsure", "manager_alerted", "", "Classification unsure. Escalated to manager.", classifyEmail, classification.reason || "Classifier returned unsure.");
      }
    } catch(e) {
      Logger.log("ERROR in handler: " + e);
      handleUnsureEmail(thread, subject, activeBody, from, "Script error: " + e);
      sessionLog.push("Error escalated: " + subject + " | " + e);
      logAction(from, subject, classification.type || "unknown", "error_escalated", "", "Script error during handler.", classifyEmail, String(e));
    }

    thread.addLabel(processedLabel);
  });

  maybeLearnFromSession(sessionLog, buildSarahContext("learning", sessionLog.join("\n"), instructions, knowledge));

  Logger.log("=== checkLeads END ===");
}

// Handles the case where a team member (Pepijn, Sang, Eimee) forwards an
// external email to Sarah to handle scheduling — e.g. Pepijn forwards
// "Nico asked for availability next week, please coordinate". Sarah replies
// directly to the external contact with calendar slots, and BCCs the forwarder.
function handleSchedulingForward(thread, msg, classification, brand, externalEmail, memory, forwardedByEmail) {
  var subject = msg.getSubject() || "";
  var body = msg.getPlainBody() || "";

  var senderInfo = analyzeEmailSender(subject, body, msg.getFrom() || "");
  var leadEmail = (senderInfo && senderInfo.replyTo && !isInternalEmail(senderInfo.replyTo))
    ? senderInfo.replyTo
    : externalEmail;
  var leadName = (senderInfo && senderInfo.name) || classification.name || "";

  if (!leadEmail) {
    handleUnsureEmail(thread, subject, body, msg.getFrom() || "", "Team forward: could not determine external email to reply to");
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

  // Reply to the external contact. BCC both the manager and the team member who forwarded.
  var bccList = [CONFIG.MANAGER];
  if (forwardedByEmail && forwardedByEmail !== CONFIG.MANAGER) bccList.push(forwardedByEmail);

  sendEmail({
    to: leadEmail,
    subject: drafted.subject,
    body: drafted.body,
    bcc: bccList.join(",")
  });

  thread.addLabel(getOrCreateLabel(CONFIG.LABEL_LEAD));
  thread.markRead();

  logAction(msg.getFrom() || "", subject, "lead", "scheduling_forward_replied",
    "", leadEmail, "Replied to external contact from team-forwarded scheduling request. BCC: " + bccList.join(", "));
  updateMemoryBrief("FORWARD", "Team-forwarded scheduling request handled for " + leadEmail + " (forwarded by " + forwardedByEmail + ")");
}

// Returns true if the email came from one of the known internal forwarding
// addresses (contact-form forwarders), meaning the real lead/client is
// mentioned inside the body rather than in the From header.
function isKnownForwarder(email) {
  var needle = (email || "").toLowerCase().trim();
  if (!needle) return false;

  return CONFIG.FORWARDERS.some(function(f) {
    return String(f || "").toLowerCase().trim() === needle;
  });
}

// Returns true if the email is from a Stramasa team member who may be
// forwarding an external lead/client email to Sarah.
function isInternalForwarder(email) {
  var needle = (email || "").toLowerCase().trim();
  if (!needle) return false;

  return (CONFIG.INTERNAL_TEAM || []).some(function(f) {
    return String(f || "").toLowerCase().trim() === needle;
  });
}

// ---- Debug function: run this to see exactly what Sarah sees without
// sending any emails or modifying any data. Check Logger output.
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

    Logger.log("THREAD: " + subject + " | from=" + from + " | msg count=" + messages.length + " | unread=" + thread.isUnread());

    var isForwarder = isKnownForwarder(fromEmail);
    var isTeamFwd = isInternalForwarder(fromEmail);
    Logger.log("  isKnownForwarder=" + isForwarder + " | isInternalForwarder=" + isTeamFwd);

    if (isForwarder || isTeamFwd) {
      var realSender = analyzeEmailSender(subject, activeBody, from);
      Logger.log("  Real sender extracted: " + JSON.stringify(realSender));
    }

    if (!isForwarder && !isTeamFwd) {
      var classification = safeClassify(subject, activeBody, from);
      Logger.log("  Classification: " + JSON.stringify(classification));
    }
  });

  Logger.log("=== debugCheckLeads END — check above for what Sarah sees ===");
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
    var thresholds = [
      CONFIG.FOLLOW_UP_1_HOURS,
      CONFIG.FOLLOW_UP_2_HOURS,
      CONFIG.FOLLOW_UP_3_HOURS
    ];

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

    logAction(
      data.leadEmail, data.subject, "lead", "followup_" + num,
      "", "Follow-up sent.", data.leadEmail, "Lead had not replied after follow-up threshold."
    );

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
