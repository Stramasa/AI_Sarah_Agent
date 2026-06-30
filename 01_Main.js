function checkLeads() {
  Logger.log("=== checkLeads START ===");
  ensureAllSheets();

  var instructions = loadInstructions();
  var knowledge = loadKnowledge();
  var sessionLog = [];
  var processedLabel = getOrCreateLabel(CONFIG.LABEL_PROCESSED);

  rescueForwardedLeadsFromSpam();

  var threads = GmailApp.search("is:unread -label:" + CONFIG.LABEL_PROCESSED, 0, 20);
  Logger.log("THREADS FOUND: " + threads.length);
  if (threads.length === 0) return;

  threads.forEach(function(thread) {
    var messages = thread.getMessages();
    var firstMsg = messages[0];
    var subject = firstMsg.getSubject() || "";
    var from = firstMsg.getFrom() || "";
    var to = firstMsg.getTo() || "";
    var firstBody = firstMsg.getPlainBody() || "";
    var threadId = thread.getId();
    var fromEmail = extractEmail(from);

    Logger.log("--- THREAD: " + subject + " | from=" + from + " | msgs=" + messages.length);

    if (fromEmail === CONFIG.FROM_EMAIL) {
      thread.addLabel(processedLabel);
      thread.markRead();
      return;
    }

    if (isBounceEmail(subject, firstBody, from)) {
      handleBounceEmail(thread, subject, firstBody, from);
      sessionLog.push("Bounce flagged to manager: " + subject);
      thread.addLabel(processedLabel);
      return;
    }

    if (isCalendlyConfirmation(subject, from, firstBody)) {
      handleCalendlyConfirmation(thread, subject, firstBody, from);
      sessionLog.push("Calendly confirmation logged without reply: " + subject);
      thread.addLabel(processedLabel);
      return;
    }

    var possibleClient = findClientInDirectorySmart(fromEmail, subject, firstBody);

    if (possibleClient) {
      Logger.log("PRE-CLASSIFY: matched known client, routing to client workflow");

      try {
        handleClientEmail(thread, firstMsg, buildSarahContext("client", firstBody, instructions, knowledge));
        sessionLog.push("Known client email processed: " + subject);

        logAction(
          from,
          subject,
          "client",
          "pre_classify_client_match",
          possibleClient.clientName || "",
          "Matched Client Directory before Claude classification.",
          possibleClient.email || fromEmail,
          "Known client match found in Client Directory."
        );
      } catch(e) {
        Logger.log("ERROR handleClientEmail pre-classify: " + e);

        handleUnsureEmail(
          thread,
          subject,
          firstBody,
          from,
          "Known client match but client handler failed: " + e
        );

        logAction(
          from,
          subject,
          "client",
          "error_escalated",
          possibleClient.clientName || "",
          "Known client match but handler failed.",
          possibleClient.email || fromEmail,
          String(e)
        );
      }

      thread.addLabel(processedLabel);
      return;
    }

    var classification = safeClassify(subject, firstBody, from);
    Logger.log("CLASSIFIED: " + JSON.stringify(classification));

    if (classification.type === "spam") {
      thread.addLabel(getOrCreateLabel(CONFIG.LABEL_SPAM));
      thread.addLabel(processedLabel);
      thread.markRead();

      logAction(
        from,
        subject,
        "spam",
        "skipped",
        "",
        "Spam/system email skipped.",
        fromEmail,
        classification.reason || ""
      );

      return;
    }

    if (classification.type === "talent") {
      thread.addLabel(getOrCreateLabel(CONFIG.LABEL_TALENT));
      thread.addLabel(processedLabel);
      thread.markRead();

      logAction(
        from,
        subject,
        "talent",
        "labeled",
        "",
        "Talent/applicant email ignored unless hiring request.",
        fromEmail,
        classification.reason || "Classified as talent/application."
      );

      return;
    }

    var brand = detectBrand(subject + " " + firstBody + " " + to);
    var props = PropertiesService.getScriptProperties();
    var hasLeadRecord = props.getProperty(CONFIG.PROP_PREFIX + threadId) !== null;

    logAction(
      from,
      subject,
      classification.type,
      "pending",
      "",
      "",
      fromEmail,
      classification.reason || ""
    );

    try {
      if (messages.length > 1 && hasLeadRecord) {
        handleLeadReply(thread, buildSarahContext("lead", firstBody, instructions, knowledge));
        sessionLog.push("Known lead reply handled: " + subject);

      } else if (classification.type === "lead") {
        handleNewLead(
          thread,
          firstMsg,
          classification,
          brand,
          buildSarahContext("lead", firstBody, instructions, knowledge)
        );
        sessionLog.push("New lead replied to: " + subject);

      } else if (classification.type === "client") {
        handleClientEmail(thread, firstMsg, buildSarahContext("client", firstBody, instructions, knowledge));
        sessionLog.push("Client/PM email processed: " + subject);

      } else {
        handleUnsureEmail(thread, subject, firstBody, from, "Classification unsure");
        sessionLog.push("Unsure email escalated: " + subject);

        logAction(
          from,
          subject,
          "unsure",
          "manager_alerted",
          "",
          "Classification unsure. Escalated to manager.",
          fromEmail,
          classification.reason || "Classifier returned unsure."
        );
      }
    } catch(e) {
      Logger.log("ERROR in handler: " + e);

      handleUnsureEmail(thread, subject, firstBody, from, "Script error: " + e);
      sessionLog.push("Error escalated: " + subject + " | " + e);

      logAction(
        from,
        subject,
        classification.type || "unknown",
        "error_escalated",
        "",
        "Script error during handler.",
        fromEmail,
        String(e)
      );
    }

    thread.addLabel(processedLabel);
  });

  maybeLearnFromSession(
    sessionLog,
    buildSarahContext("learning", sessionLog.join("\n"), instructions, knowledge)
  );

  Logger.log("=== checkLeads END ===");
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

    sendEmail({
      to: data.leadEmail,
      subject: subjectWithRe(data.subject),
      body: body,
      bcc: CONFIG.MANAGER
    });

    logAction(
      data.leadEmail,
      data.subject,
      "lead",
      "followup_" + num,
      "",
      "Follow-up sent.",
      data.leadEmail,
      "Lead had not replied after follow-up threshold."
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