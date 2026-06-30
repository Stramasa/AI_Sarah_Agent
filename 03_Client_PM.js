function handleClientEmail(thread, msg, memory) {
  var subject = msg.getSubject() || "";
  var body = msg.getPlainBody() || "";
  var fromEmail = extractEmail(msg.getFrom() || "");

  var clientData = findClientInDirectorySmart(fromEmail, subject, body);
  var clientEmail = clientData && clientData.email
    ? clientData.email
    : extractLikelyExternalClientEmail(body, fromEmail);

  var teamContext = getSheetContext("Team", 20);
  var pmContext = getSheetContext("PM", 30);

  var action = determineClientPMAction(body, subject, clientData, teamContext, pmContext, memory);
  var clientName = clientData ? clientData.clientName : (action.client || "Unknown");

  updateClientDirectoryFromEmail(clientEmail, clientData, subject, action);
  updatePMFromClientEmail(clientName, clientEmail, subject, action);
  maybeNotifyTeamOwner(clientName, clientData, action, subject, body, clientEmail);

  if (action.escalate === true || action.action === "escalate") {
    handleUnsureEmail(
      thread,
      subject,
      body,
      msg.getFrom(),
      "Client/PM escalation: " + (action.reason || action.next_action || "Needs review")
    );
  }

  logAction(
    fromEmail,
    subject,
    "client",
    action.action || "logged",
    clientName,
    clientEmail,
    action.next_action || action.summary || "Client email processed"
  );

  updateMemoryBrief(
    "CLIENT",
    "Client email processed for " + clientName + " <" + clientEmail + ">: " + (action.summary || subject)
  );

  thread.addLabel(getOrCreateLabel(CONFIG.LABEL_CLIENT));
  thread.markRead();
}

function determineClientPMAction(body, subject, clientData, teamContext, pmContext, memory) {
  var clientCtx = clientData ? JSON.stringify(clientData) : "Client not found in Client Directory.";

  var prompt =
    "You are Sarah, the internal operations coordinator for Stramasa.\n" +
    "You are processing an EXISTING CLIENT email.\n" +
    "Sarah NEVER replies to clients. She only updates internal tracking and coordinates the team.\n\n" +

    "Client context:\n" + clientCtx + "\n\n" +
    "Team context:\n" + teamContext + "\n\n" +
    "PM context:\n" + pmContext + "\n\n" +
    "Sarah memory:\n" + (memory || "").substring(0,2500) + "\n\n" +

    "Email subject:\n" + subject + "\n\n" +
    "Email body:\n" + body.substring(0,2200) + "\n\n" +

    "Return ONLY valid JSON:\n" +
    "{\"action\":\"log_only|add_next_action|update_project|escalate\",\"client\":\"\",\"project\":\"\",\"team_owner\":\"\",\"deadline\":\"\",\"next_action\":\"\",\"blocker\":\"\",\"summary\":\"\",\"internal_email_needed\":false,\"internal_email_reason\":\"\",\"internal_message\":\"\",\"escalate\":false,\"reason\":\"\"}\n\n" +

    "Decision rules:\n" +
    "- Sarah never replies to clients.\n" +
    "- Decide what operational work needs to happen internally.\n" +
    "- If the email is only informational (thanks, acknowledged, received, etc.) use log_only and internal_email_needed=false.\n" +
    "- Only notify a team member if someone genuinely needs to do work.\n" +
    "- Use Sang for operational execution, PM, scheduling, coordination and admin.\n" +
    "- Use Eimee for creative work.\n" +
    "- Use Pepijn only for strategy, pricing, scope, complaints, legal, finance or unclear ownership.\n" +
    "- Escalate when ownership or responsibility is unclear.\n\n" +

    "The summary field is ONLY for the PM spreadsheet.\n" +
    "Keep it short (1 sentence).\n\n" +

    "The internal_message is DIFFERENT.\n" +
    "Write it as a professional internal email.\n" +
    "Do NOT copy the client email.\n" +
    "Instead:\n" +
    "- greet the team member by first name\n" +
    "- explain why you're emailing\n" +
    "- mention which client this relates to\n" +
    "- briefly reference the client's latest email\n" +
    "- summarize the important decisions\n" +
    "- finish with a short 'Action points:' section using bullet points\n" +
    "- never exceed about 180 words\n" +
    "- do NOT sound robotic\n" +
    "- do NOT repeat the entire client email\n" +
    "- write as an experienced project coordinator\n";

  try {

    var result = JSON.parse(cleanJson(callClaude(prompt,"claude-haiku-4-5-20251001")));

    if(result.internal_email_needed!==true)
      result.internal_email_needed=false;

    if(!result.summary)
      result.summary="Client email processed.";

    if(!result.reason)
      result.reason="Client workflow processed.";

    return result;

  } catch(e){

    Logger.log("determineClientPMAction error: "+e);

    return{
      action:"log_only",
      client:"",
      project:"",
      team_owner:"",
      deadline:"",
      next_action:"",
      blocker:"",
      summary:"Client email logged",
      internal_email_needed:false,
      internal_email_reason:"",
      internal_message:"",
      escalate:false,
      reason:"Client PM action parser failed: "+e
    };
  }
}

function findClientInDirectory(email) {
  try {
    var sheet = getSheet("Client Directory");
    if (!sheet) return null;

    var data = sheet.getDataRange().getValues();
    var headers = data[0];
    var map = headerMap(headers);
    var needle = (email || "").toLowerCase();

    if (!needle) return null;

    for (var i = 1; i < data.length; i++) {
      var rowText = data[i].join(" ").toLowerCase();
      if (rowText.indexOf(needle) !== -1) {
        return buildClientDirectoryObject(data[i], map, i + 1);
      }
    }
  } catch(e) {
    Logger.log("findClientInDirectory error: " + e);
  }

  return null;
}

function findClientInDirectorySmart(email, subject, body) {
  var direct = findClientInDirectory(email);
  if (direct && !isInternalEmail(email)) return direct;

  try {
    var sheet = getSheet("Client Directory");
    if (!sheet) return null;

    var data = sheet.getDataRange().getValues();
    var headers = data[0];
    var map = headerMap(headers);

    var haystack = normalizeClientMatchText((subject || "") + " " + (body || ""));
    var bodyEmails = extractAllEmails(body).map(function(e) {
      return e.toLowerCase().trim();
    });

    for (var i = 1; i < data.length; i++) {
      var row = data[i];

      var clientName = normalizeClientMatchText(val(row, map, "Client Name"));
      var company = normalizeClientMatchText(val(row, map, "Company"));
      var contactName = normalizeClientMatchText(val(row, map, "Contact Name"));
      var contacts = normalizeClientMatchText(val(row, map, "Contacts"));
      var emailCell = String(val(row, map, "Email") || "").toLowerCase().trim();
      var knownEmails = String(val(row, map, "Known Emails") || "").toLowerCase();
      var aliases = String(val(row, map, "Aliases") || "").toLowerCase();

      if (emailCell && bodyEmails.indexOf(emailCell) !== -1) {
        return buildClientDirectoryObject(row, map, i + 1);
      }

      if (knownEmails) {
        var knownList = splitList(knownEmails);
        for (var ke = 0; ke < knownList.length; ke++) {
          if (knownList[ke] && bodyEmails.indexOf(knownList[ke]) !== -1) {
            return buildClientDirectoryObject(row, map, i + 1);
          }
        }
      }

      if (clientName && containsClientPhrase(haystack, clientName)) {
        return buildClientDirectoryObject(row, map, i + 1);
      }

      if (company && containsClientPhrase(haystack, company)) {
        return buildClientDirectoryObject(row, map, i + 1);
      }

      if (contactName && containsClientPhrase(haystack, contactName)) {
        return buildClientDirectoryObject(row, map, i + 1);
      }

      if (contacts) {
        var contactList = splitList(contacts);
        for (var c = 0; c < contactList.length; c++) {
          if (contactList[c] && containsClientPhrase(haystack, normalizeClientMatchText(contactList[c]))) {
            return buildClientDirectoryObject(row, map, i + 1);
          }
        }
      }

      if (aliases) {
        var aliasList = splitList(aliases);
        for (var a = 0; a < aliasList.length; a++) {
          if (aliasList[a] && containsClientPhrase(haystack, normalizeClientMatchText(aliasList[a]))) {
            return buildClientDirectoryObject(row, map, i + 1);
          }
        }
      }
    }
  } catch(e) {
    Logger.log("findClientInDirectorySmart error: " + e);
  }

  return null;
}

function buildClientDirectoryObject(row, map, rowNum) {
  return {
    row: rowNum,
    clientName: val(row, map, "Client Name"),
    company: val(row, map, "Company"),
    contactName: val(row, map, "Contact Name"),
    contacts: val(row, map, "Contacts"),
    email: val(row, map, "Email"),
    knownEmails: val(row, map, "Known Emails"),
    aliases: val(row, map, "Aliases"),
    timezone: val(row, map, "Timezone"),
    projects: val(row, map, "Projects"),
    projectOwner: val(row, map, "Project Owner") || val(row, map, "Team Owner"),
    status: val(row, map, "Status"),
    priority: val(row, map, "Priority"),
    notes: val(row, map, "Important Notes") || val(row, map, "Notes")
  };
}

function updateClientDirectoryFromEmail(email, clientData, subject, action) {
  var sheet = getSheet("Client Directory");
  if (!sheet) return;

  var headers = getHeaders(sheet);
  var map = headerMap(headers);
  var rowNum = clientData && clientData.row ? clientData.row : null;

  if (!rowNum) {
    appendObjectRow("Client Directory", {
      "Client Name": action.client || "Unknown",
      "Company": action.client || "",
      "Contact Name": "",
      "Email": isInternalEmail(email) ? "" : email,
      "Known Emails": isInternalEmail(email) ? "" : email,
      "Aliases": "",
      "Timezone": "",
      "Status": "active?",
      "Priority": "",
      "Notes": "",
      "Contacts": "",
      "Projects": action.project || "",
      "Important Notes": "Added by Sarah from client/PM email. Please verify.",
      "Last Email Subject": subject,
      "Last Email DateTime": isoNow(),
      "Sarah Action": action.action || "logged",
      "Next Action": action.next_action || ""
    });
    return;
  }

  setByHeader(sheet, rowNum, map, "Last Email Subject", subject);
  setByHeader(sheet, rowNum, map, "Last Email DateTime", isoNow());
  setByHeader(sheet, rowNum, map, "Sarah Action", action.action || "logged");

  if (email && !isInternalEmail(email) && map["Known Emails"] !== undefined) {
    var oldKnown = getByHeader(sheet, rowNum, map, "Known Emails") || "";
    if (oldKnown.toLowerCase().indexOf(email.toLowerCase()) === -1) {
      setByHeader(sheet, rowNum, map, "Known Emails", oldKnown ? oldKnown + ", " + email : email);
    }
  }

  if (action.next_action) {
    setByHeader(sheet, rowNum, map, "Next Action", action.next_action);
  }

  if (action.project) {
    var oldProjects = getByHeader(sheet, rowNum, map, "Projects") || "";
    if (oldProjects.toLowerCase().indexOf(String(action.project).toLowerCase()) === -1) {
      setByHeader(sheet, rowNum, map, "Projects", oldProjects ? oldProjects + "\n" + action.project : action.project);
    }
  }

  if (action.summary) {
    var notesHeader = map["Important Notes"] !== undefined ? "Important Notes" : "Notes";
    var oldNotes = getByHeader(sheet, rowNum, map, notesHeader) || "";
    var newNote = isoNow() + ": " + action.summary;
    setByHeader(sheet, rowNum, map, notesHeader, oldNotes ? oldNotes + "\n" + newNote : newNote);
  }
}

function updatePMFromClientEmail(clientName, email, subject, action) {
  if (!action) return;

  if (!action.next_action && !action.summary && !action.blocker && action.action === "log_only") return;

  appendObjectRow("PM", {
    "Client": clientName || action.client || "Unknown",
    "Project": action.project || "",
    "Team Owner": action.team_owner || "",
    "Deadline": action.deadline || "",
    "Next Actions": action.next_action || action.summary || "Review latest client email",
    "Blockers": action.blocker || "",
    "Last Update": isoNow(),
    "Source Email": (email || "") + " | " + subject,
    "Sarah Action": action.action || "logged"
  });
}

function getSheetContext(tab, maxRows) {
  try {
    var sheet = getSheet(tab);
    if (!sheet) return "";

    var rows = sheet.getDataRange().getValues();
    return rows
      .slice(0, maxRows || 20)
      .map(function(r) { return r.join(" | "); })
      .join("\n");
  } catch(e) {
    return "";
  }
}

function extractAllEmails(text) {
  var matches = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig);
  return matches || [];
}

function extractLikelyExternalClientEmail(body, fallbackEmail) {
  var emails = extractAllEmails(body);

  for (var i = 0; i < emails.length; i++) {
    var e = emails[i];
    var lower = e.toLowerCase();

    if (
      !isInternalEmail(e) &&
      lower.indexOf("no-reply") === -1 &&
      lower.indexOf("noreply") === -1 &&
      lower.indexOf("mailer-daemon") === -1
    ) {
      return e;
    }
  }

  return isInternalEmail(fallbackEmail) ? "" : fallbackEmail;
}

function splitList(value) {
  return String(value || "")
    .split(/[,;\n]/)
    .map(function(x) { return x.trim().toLowerCase(); })
    .filter(function(x) { return x.length > 0; });
}

function normalizeClientMatchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s@.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsClientPhrase(haystack, phrase) {
  if (!phrase) return false;
  if (phrase.length < 3) return false;
  return haystack.indexOf(phrase) !== -1;
}