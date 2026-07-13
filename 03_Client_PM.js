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

  var action = orchestrateClientEmail(body, subject, clientData, teamContext, pmContext, memory);
  var clientName = clientData ? clientData.clientName : (action.client || "Unknown");

  updateClientDirectoryFromEmail(clientEmail, clientData, subject, action, subject + " " + body);
  updatePMFromClientEmail(clientName, clientEmail, subject, action);
  maybeNotifyTeamOwner(clientName, clientData, action, subject, body, clientEmail);

  // HubSpot pipeline stage advance — only fires when Claude explicitly signalled
  // a stage transition via the hubspot_advance_stage tool. Looks up the deal by
  // the lead's email so it works for both active leads and known-client threads.
  if (action.hubspot_stage_signal) {
    var targetStage = HUBSPOT_SIGNAL_MAP[action.hubspot_stage_signal];
    if (targetStage) {
      var leadRow = findLeadSheetRowByEmail(clientEmail);
      var dealId = leadRow ? leadRow.dealId : null;
      if (dealId) {
        var moved = advanceHubspotDealStage(dealId, targetStage);
        Logger.log("HubSpot stage signal '" + action.hubspot_stage_signal + "' for " + clientEmail +
          " (deal " + dealId + "): " + (moved ? "advanced" : "already at/beyond target") +
          " — reason: " + (action.hubspot_stage_reason || ""));
      } else {
        Logger.log("HubSpot stage signal '" + action.hubspot_stage_signal + "' for " + clientEmail +
          " but no dealId found in Leads sheet — skipping");
      }
    }
  }

  if (action.escalate === true) {
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

// ---- Tool-use orchestration ------------------------------------------
// Claude is given three tools (log_client_update, notify_team_member,
// escalate_to_manager) and picks any combination that fits - one call,
// zero to three tools used. This replaces the old single fixed JSON
// schema, which meant a new field (and new code to read it) for every
// new kind of decision. Adding a new decision now just means adding a
// new tool in 10_Tool_Registry.js, not a new if/else branch here.
function orchestrateClientEmail(body, subject, clientData, teamContext, pmContext, memory) {
  var clientCtx = clientData ? JSON.stringify(clientData) : "Client not found in Client Directory.";

  var system =
    "You are Sarah, the internal operations coordinator for Stramasa Group. " +
    "You are processing an EXISTING CLIENT or PROSPECT email. Sarah NEVER replies to clients - she only " +
    "updates internal tracking and coordinates the team via the tools available to you. " +
    "You also monitor the sales pipeline. If the email clearly signals that a deal has reached a new stage " +
    "(a proposal is being created, a proposal was sent, the team is following up on a sent proposal, or the " +
    "prospect is actively negotiating scope/pricing), call hubspot_advance_stage with the matching signal. " +
    "Only call it when the evidence in the email is clear and unambiguous — never speculatively.";

  var userPrompt =
    "Client context:\n" + clientCtx + "\n\n" +
    "Team context:\n" + teamContext + "\n\n" +
    "PM context:\n" + pmContext + "\n\n" +
    "Sarah memory:\n" + (memory || "").substring(0, 2500) + "\n\n" +
    "Email subject:\n" + subject + "\n\n" +
    "Email body:\n" + body.substring(0, 2200) + "\n\n" +
    "Always call log_client_update at minimum. Only call notify_team_member if someone genuinely " +
    "needs to do work - not for purely informational emails (thanks, acknowledged, received). " +
    "Only call escalate_to_manager if ownership or responsibility is unclear, or the situation needs " +
    "human judgment. Call hubspot_advance_stage only when there is clear, unambiguous evidence in this " +
    "email that the deal has reached a specific stage (proposal being created, proposal sent, following up " +
    "on proposal, or active negotiation). You may call more than one tool if the situation calls for it.";

  var defaults = {
    action: "log_only",
    client: (clientData && clientData.clientName) || "",
    project: "",
    team_owner: "",
    deadline: "",
    next_action: "",
    blocker: "",
    summary: "Client email logged",
    escalate: false,
    reason: ""
  };

  try {
    var result = callClaudeTools(userPrompt, CLIENT_TOOLS, system, "claude-haiku-4-5-20251001", "any");
    return mergeClientToolCalls(result.toolCalls, defaults);
  } catch (e) {
    Logger.log("orchestrateClientEmail error: " + e);
    defaults.reason = "Client PM orchestration failed: " + e;
    return defaults;
  }
}

// Folds the (0-3) tool calls Claude made into one action object shaped
// the way updateClientDirectoryFromEmail / updatePMFromClientEmail /
// maybeNotifyTeamOwner already expect, so those three functions in
// 03/04 don't need to change at all.
function mergeClientToolCalls(toolCalls, defaults) {
  var action = Object.assign({}, defaults);

  (toolCalls || []).forEach(function(call) {
    if (call.name === "log_client_update") {
      var i = call.input || {};
      action.action = i.action_type || action.action;
      action.client = i.client_name || action.client;
      action.project = i.project || action.project;
      action.team_owner = i.team_owner || action.team_owner;
      action.deadline = i.deadline || action.deadline;
      action.next_action = i.next_action || action.next_action;
      action.blocker = i.blocker || action.blocker;
      action.summary = i.summary || action.summary;
    }

    if (call.name === "notify_team_member") {
      var n = call.input || {};
      action.internal_email_needed = true;
      if (n.owner_name) action.team_owner = n.owner_name;
      action.internal_email_reason = n.reason || "";
    }

    if (call.name === "escalate_to_manager") {
      var esc = call.input || {};
      action.escalate = true;
      action.reason = esc.reason || action.reason;
    }

    if (call.name === "hubspot_advance_stage") {
      var hs = call.input || {};
      action.hubspot_stage_signal = hs.stage_signal || "";
      action.hubspot_stage_reason = hs.reason || "";
    }
  });

  return action;
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

function updateClientDirectoryFromEmail(email, clientData, subject, action, sourceText) {
  var sheet = getSheet("Client Directory");
  if (!sheet) return;

  var headers = getHeaders(sheet);
  var map = headerMap(headers);
  var rowNum = clientData && clientData.row ? clientData.row : null;
  var inferredTz = guessTimezoneLabel((sourceText || "") + " " + (email || ""));

  if (!rowNum) {
    appendObjectRow("Client Directory", {
      "Client Name": action.client || "Unknown",
      "Company": action.client || "",
      "Contact Name": "",
      "Email": isInternalEmail(email) ? "" : email,
      "Known Emails": isInternalEmail(email) ? "" : email,
      "Aliases": "",
      "Timezone": inferredTz,
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

  // Fill gaps only - never overwrite a value that's already there.
  if (email && !isInternalEmail(email)) {
    if (map["Email"] !== undefined && !getByHeader(sheet, rowNum, map, "Email")) {
      setByHeader(sheet, rowNum, map, "Email", email);
    }

    if (map["Known Emails"] !== undefined) {
      var oldKnown = getByHeader(sheet, rowNum, map, "Known Emails") || "";
      if (oldKnown.toLowerCase().indexOf(email.toLowerCase()) === -1) {
        setByHeader(sheet, rowNum, map, "Known Emails", oldKnown ? oldKnown + ", " + email : email);
      }
    }
  }

  if (map["Company"] !== undefined && !getByHeader(sheet, rowNum, map, "Company") && action.client) {
    setByHeader(sheet, rowNum, map, "Company", action.client);
  }

  if (map["Timezone"] !== undefined && !getByHeader(sheet, rowNum, map, "Timezone") && inferredTz) {
    setByHeader(sheet, rowNum, map, "Timezone", inferredTz);
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

// Reuses the existing timezone-region detector (07_Calendar_Timezone.js)
// and turns it into a short human label for the sheet, e.g. "ET (US)".
function guessTimezoneLabel(text) {
  try {
    var region = detectTimezoneRegion(text || "");
    var target = TARGET_TZ[region];
    if (!target) return "";
    return target.label + " (" + region + ")";
  } catch (e) {
    return "";
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