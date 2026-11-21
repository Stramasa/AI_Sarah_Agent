// ---- Manager reply to an "unsure" escalation ---------------------------
// When Sarah escalates an email as unsure, she labels it SarahUnsure and
// marks it processed. If Pepijn (or another internal team member) then replies
// saying "this is a normal lead, contact them", that reply lands in a thread
// already labeled SarahProcessed — so the main checkLeads search never sees it.
// This function scans for exactly that case and re-runs the normal lead flow.
function handleManagerUnsureReplies() {
  var processedLabel = getOrCreateLabel(CONFIG.LABEL_PROCESSED);
  var unsureLabel = getOrCreateLabel(CONFIG.LABEL_UNSURE);
  if (!unsureLabel) return;

  var threads;
  try {
    threads = GmailApp.search(
      "label:" + CONFIG.LABEL_UNSURE + " is:unread",
      0, 25
    );
  } catch (e) {
    Logger.log("handleManagerUnsureReplies search error: " + e);
    return;
  }
  if (!threads || threads.length === 0) return;

  threads.forEach(function(thread) {
    var messages = thread.getMessages();
    var lastMsg = messages[messages.length - 1];
    var fromEmail = extractEmail(lastMsg.getFrom() || "");

    // Only act on replies from internal team (not the original lead replying).
    if (!isInternalEmail(fromEmail) || fromEmail === CONFIG.FROM_EMAIL) return;

    var body = lastMsg.getPlainBody() || "";
    var subject = lastMsg.getSubject() || "";

    var decision = classifyManagerUnsureReply(body);
    Logger.log("handleManagerUnsureReplies: '" + subject + "' -> " + decision);

    if (decision !== "lead") {
      // Manager said it's not a lead, or it's ambiguous. Mark read and leave.
      thread.markRead();
      return;
    }

    // Manager confirmed it IS a normal lead. Find the original external
    // message in the thread (the one Sarah was unsure about) and run the
    // normal new-lead flow on it.
    var leadMsg = null;
    for (var i = messages.length - 1; i >= 0; i--) {
      var mEmail = extractEmail(messages[i].getFrom() || "");
      if (mEmail !== CONFIG.FROM_EMAIL && !isInternalEmail(mEmail)) {
        leadMsg = messages[i];
        break;
      }
    }
    if (!leadMsg) {
      Logger.log("handleManagerUnsureReplies: no external lead message found in thread " + thread.getId());
      thread.markRead();
      return;
    }

    var leadSubject = leadMsg.getSubject() || "";
    var leadBody = leadMsg.getPlainBody() || "";
    var leadFrom = leadMsg.getFrom() || "";

    // Re-extract the real external sender (form forwarders bury it in the body).
    var senderInfo = analyzeEmailSender(leadSubject, leadBody, leadFrom);
    var leadEmail = (senderInfo && senderInfo.replyTo && !isInternalEmail(senderInfo.replyTo))
      ? senderInfo.replyTo
      : extractEmail(leadFrom);
    var leadName = (senderInfo && senderInfo.name) || "";

    if (!leadEmail || isInternalEmail(leadEmail)) {
      Logger.log("handleManagerUnsureReplies: could not determine external lead email for " + subject);
      thread.markRead();
      return;
    }

    // Check for duplicates — if Sarah already contacted this lead after the
    // escalation (e.g. manager handled it manually), don't double-send.
    if (findActiveLead(leadEmail)) {
      Logger.log("handleManagerUnsureReplies: " + leadEmail + " already contacted, skipping");
      thread.markRead();
      return;
    }

    var to = lastMsg.getTo() || "";
    var brand = detectBrand(leadSubject + " " + leadBody + " " + to);
    var instructions = loadInstructions();
    var knowledge = loadKnowledge();

    var classification = {
      type: "lead",
      name: leadName,
      service_interest: "",
      company: "",
      reason: "Manager confirmed this is a normal lead after unsure escalation."
    };
    try {
      var quick = safeClassify(leadSubject, leadBody, leadEmail, instructions);
      if (quick && quick.type === "lead") {
        classification.service_interest = quick.service_interest || "";
        classification.company = quick.company || "";
      }
    } catch (ce) {
      Logger.log("handleManagerUnsureReplies reclassify error: " + ce);
    }

    var memory = buildSarahContext("lead", leadBody, instructions, knowledge);

    try {
      handleNewLead(thread, leadMsg, classification, brand, memory, fromEmail);
      logAction(leadFrom, leadSubject, "lead", "manager_confirmed_lead", "", leadEmail,
        "Manager (" + fromEmail + ") confirmed unsure email is a normal lead. Sarah contacted the lead.");
      updateMemoryBrief("LEAD",
        "Manager confirmed unsure escalation was a real lead: " + leadName + " <" + leadEmail + ">. Sarah reached out.");
    } catch (he) {
      Logger.log("handleManagerUnsureReplies handleNewLead error: " + he);
    }

    thread.markRead();
  });
}

// Classifies a manager's reply to an "unsure" escalation.
// Returns "lead" (manager says go ahead, it's a normal lead),
// "notlead" (manager says ignore / it's spam / not a lead),
// or "ambiguous" (unclear).
function classifyManagerUnsureReply(body) {
  var prompt =
    "A manager replied to an email that Sarah (an AI assistant) escalated as 'unsure'.\n" +
    "The manager is telling Sarah what to do with the original email.\n\n" +
    "Return exactly one word:\n" +
    "- LEAD — if the manager says this is a normal/good lead and Sarah should contact the prospect (e.g. 'thats normal, contact him', 'go ahead', 'reach out', 'this is a lead, send the intro', 'yes contact them').\n" +
    "- NOTLEAD — if the manager says to ignore it, it's spam, it's not a lead, or to do nothing.\n" +
    "- AMBIGUOUS — if the reply is unclear or does not clearly direct Sarah to act.\n\n" +
    "Reply text:\n" + (body || "").substring(0, 600);
  try {
    var r = callClaude(prompt, "claude-haiku-4-5-20251001").trim().toUpperCase();
    if (r.indexOf("LEAD") === 0 && r.indexOf("NOTLEAD") === -1) return "lead";
    if (r.indexOf("NOTLEAD") === 0) return "notlead";
    if (r.indexOf("AMBIGUOUS") === 0) return "ambiguous";
    // Fallback keyword check for the common "No thats normal" pattern.
    var lower = (body || "").toLowerCase();
    if (/(thats normal|that's normal|this is normal|normal lead|go ahead|contact him|contact them|reach out|send the|yes)/i.test(lower)) return "lead";
    if (/(ignore|not a lead|spam|do nothing|leave it|dismiss)/i.test(lower)) return "notlead";
  } catch (e) {
    Logger.log("classifyManagerUnsureReply error: " + e);
  }
  return "ambiguous";
}

function maybeNotifyTeamOwner(clientName, clientData, action, subject, body, clientEmail) {
  if (!action) return;

  if (action.internal_email_needed !== true) {
    Logger.log("TEAM ROUTING: no internal email needed for " + (clientName || "client"));
    return;
  }

  var ownerName = resolveProjectOwner(clientName, clientData, action);

  if (!ownerName) {
    ownerName = "Pepijn van Vliet";
  }

  var owner = findTeamMemberByName(ownerName);

  if (!owner || !owner.email || owner.canAssign === false) {
    owner = findTeamMemberByName("Pepijn");
  }

  if (!owner || !owner.email) {
    logAction(
      clientEmail || "",
      subject || "",
      "client",
      "internal_notification_failed",
      clientName || "",
      "Could not find project owner/team member.",
      clientEmail || "",
      "Team owner could not be resolved."
    );
    return;
  }

  if (isInternalEmail(owner.email) === false) {
    logAction(
      clientEmail || "",
      subject || "",
      "client",
      "internal_notification_blocked",
      clientName || "",
      "Blocked internal notification because recipient is not internal.",
      owner.email,
      "Safety rule: team notifications only go to internal emails."
    );
    return;
  }

  var message = buildInternalTeamMessage(owner.name, clientName, action, subject, body, clientEmail);

  // NEW: Build CC list with project owner logic
  var ccList = [];
  var projectOwnerName = resolveProjectOwner(clientName, clientData, action);
  
  if (projectOwnerName && projectOwnerName.trim().length > 0) {
    // Only CC the project owner if they are NOT the person being notified
    if (projectOwnerName !== owner.name) {
      var projectOwnerData = findTeamMemberByName(projectOwnerName);
      if (projectOwnerData && projectOwnerData.email && isInternalEmail(projectOwnerData.email)) {
        ccList.push(projectOwnerData.email);
      }
    }
  }

  var emailParams = {
    to: owner.email,
    subject: "Sarah update: " + (clientName || "Client") + " - " + (action.project || subject || "Client email"),
    body: message,
    bcc: CONFIG.MANAGER
  };

  // Only add CC if there are people to CC
  if (ccList.length > 0) {
    emailParams.cc = ccList.join(",");
  }

  sendEmail(emailParams);

  logAction(
    clientEmail || "",
    subject || "",
    "client",
    "internal_team_notified",
    clientName || "",
    "Internal notification sent to " + owner.name + (ccList.length > 0 ? " (CC: " + ccList.join(", ") + ")" : "") + ".",
    owner.email,
    action.internal_email_reason || action.reason || "Sarah routed client/PM update to project owner."
  );
}

function resolveProjectOwner(clientName, clientData, action) {
  if (action && action.team_owner) {
    return action.team_owner;
  }

  if (action && action.project) {
    var pmOwner = findProjectOwnerInPM(clientName, action.project);
    if (pmOwner) return pmOwner;
  }

  if (clientData) {
    if (clientData.projectOwner) return clientData.projectOwner;
    if (clientData.teamOwner) return clientData.teamOwner;
  }

  var clientOwner = findProjectOwnerInClientDirectory(clientName);
  if (clientOwner) return clientOwner;

  var latestPmOwner = findProjectOwnerInPM(clientName, "");
  if (latestPmOwner) return latestPmOwner;

  return "Pepijn";
}

function findProjectOwnerInClientDirectory(clientName) {
  try {
    var sheet = getSheet("Client Directory");
    if (!sheet || !clientName) return "";

    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return "";

    var map = headerMap(data[0]);
    var target = normalizeClientMatchText(clientName);

    for (var i = 1; i < data.length; i++) {
      var rowClient = normalizeClientMatchText(val(data[i], map, "Client Name"));
      var rowCompany = normalizeClientMatchText(val(data[i], map, "Company"));

      if (rowClient === target || rowCompany === target) {
        return val(data[i], map, "Project Owner") || val(data[i], map, "Team Owner") || "";
      }
    }
  } catch(e) {
    Logger.log("findProjectOwnerInClientDirectory error: " + e);
  }

  return "";
}

function findProjectOwnerInPM(clientName, projectName) {
  try {
    var sheet = getSheet("PM");
    if (!sheet || !clientName) return "";

    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return "";

    var map = headerMap(data[0]);
    var targetClient = normalizeClientMatchText(clientName);
    var targetProject = normalizeClientMatchText(projectName || "");

    for (var i = data.length - 1; i >= 1; i--) {
      var rowClient = normalizeClientMatchText(val(data[i], map, "Client"));
      var rowProject = normalizeClientMatchText(val(data[i], map, "Project"));
      var owner = val(data[i], map, "Project Owner") || val(data[i], map, "Team Owner");

      if (!owner) continue;

      var clientMatches = rowClient === targetClient || rowClient.indexOf(targetClient) !== -1 || targetClient.indexOf(rowClient) !== -1;
      var projectMatches = !targetProject || rowProject === targetProject || rowProject.indexOf(targetProject) !== -1 || targetProject.indexOf(rowProject) !== -1;

      if (clientMatches && projectMatches) {
        return owner;
      }
    }
  } catch(e) {
    Logger.log("findProjectOwnerInPM error: " + e);
  }

  return "";
}

function findTeamMemberByName(name) {
  try {
    var sheet = getSheet("Team");
    if (!sheet || !name) return null;

    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return null;

    var map = headerMap(data[0]);
    var target = normalizeClientMatchText(name);

    for (var i = 1; i < data.length; i++) {
      var rowName = normalizeClientMatchText(val(data[i], map, "Name"));
      var rowEmail = val(data[i], map, "Email");
      var canAssignRaw = String(val(data[i], map, "Sarah Can Assign?") || "").toLowerCase();

      if (!rowName) continue;

      if (rowName === target || rowName.indexOf(target) !== -1 || target.indexOf(rowName) !== -1) {
        return {
          name: val(data[i], map, "Name"),
          email: rowEmail,
          timezone: val(data[i], map, "Timezone"),
          role: val(data[i], map, "Role"),
          skills: val(data[i], map, "Skills") || val(data[i], map, "Role and Skills"),
          canAssign: canAssignRaw !== "no" && canAssignRaw !== "false"
        };
      }
    }
  } catch(e) {
    Logger.log("findTeamMemberByName error: " + e);
  }

  return null;
}

function buildInternalTeamMessage(ownerName, clientName, action, subject, body, clientEmail) {
  var firstName = String(ownerName || "there").split(" ")[0];

  var message =
    "Hi " + firstName + ",\n\n" +
    "Following up on the client email from " + (clientEmail || "the client") + " about " + (action.project || subject || "the project") + ".\n\n";

  if (action.summary) {
    message += "Summary:\n" + action.summary + "\n\n";
  }

  message += "Action points:\n";

  if (action.next_action) {
    message += "- " + action.next_action + "\n";
  }

  if (action.deadline) {
    message += "- Deadline/timing: " + action.deadline + "\n";
  }

  if (action.blocker) {
    message += "- Blocker to resolve: " + action.blocker + "\n";
  }

  if (!action.next_action && !action.deadline && !action.blocker) {
    message += "- Please review and take the lead where needed.\n";
  }

  if (action.escalate === true || action.action === "escalate") {
    message += "- Sarah flagged this for review";
    if (action.reason) message += ": " + action.reason;
    message += "\n";
  }

  message += "\nThanks,\nSarah";

  return message;
}