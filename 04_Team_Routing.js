function maybeNotifyTeamOwner(clientName, clientData, action, subject, body, clientEmail) {
  if (!action) return;

  if (action.internal_email_needed !== true) {
    Logger.log("TEAM ROUTING: no internal email needed for " + (clientName || "client"));
    return;
  }

  var ownerName = resolveProjectOwner(clientName, clientData, action);

  if (!ownerName) {
    ownerName = "Sang Nguyen";
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