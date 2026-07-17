// One-time helper: run manually from the editor, check Logger output,
// copy the pipeline id + 3 stage ids into CONFIG, then ignore this function.
function getHubspotPipelines() {
  var resp = UrlFetchApp.fetch("https://api.hubapi.com/crm/v3/pipelines/deals", {
    headers: { Authorization: "Bearer " + CONFIG.HUBSPOT_TOKEN },
    muteHttpExceptions: true
  });
  Logger.log(resp.getContentText());
}

// One-time helper: run manually to find the HubSpot user ID for sang@stramasa.com,
// then store it in Script Properties as HUBSPOT_OWNER_ID.
function getHubspotOwners() {
  var resp = UrlFetchApp.fetch("https://api.hubapi.com/crm/v3/owners?limit=100", {
    headers: { Authorization: "Bearer " + CONFIG.HUBSPOT_TOKEN },
    muteHttpExceptions: true
  });
  Logger.log(resp.getContentText());
}

var HUBSPOT_BRAND_INITIALS = {
  "Stramasa":              "S",
  "Axpira":                "A",
  "Kobelphi":              "K",
  "The Content Powerhouse":"CP",
  "Introlynk":             "I",
  "Vientra":               "V",
  "Recruitshore":          "R"
};

// Returns the HubSpot owner ID for the default deal assignee (Sang).
// Owner IDs are hardcoded in CONFIG because the owners API lookup was unreliable.
function _getHubspotOwnerId_() {
  return CONFIG.HUBSPOT_OWNER_DEFAULT || CONFIG.HUBSPOT_OWNER_SANG || null;
}

// Searches for a contact by email. Returns the contact ID or null.
function _findHubspotContact_(email) {
  if (!email) return null;
  try {
    var resp = UrlFetchApp.fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        method: "post",
        contentType: "application/json",
        headers: { Authorization: "Bearer " + CONFIG.HUBSPOT_TOKEN },
        payload: JSON.stringify({
          filterGroups: [{
            filters: [{ propertyName: "email", operator: "EQ", value: email }]
          }],
          properties: ["email", "firstname", "lastname"],
          limit: 1
        }),
        muteHttpExceptions: true
      }
    );
    var json = JSON.parse(resp.getContentText());
    if (json.results && json.results.length > 0) {
      return json.results[0].id;
    }
  } catch (e) {
    Logger.log("HubSpot contact search error: " + e);
  }
  return null;
}

// Creates a HubSpot contact and returns its ID, or null on failure.
function _createHubspotContact_(lead) {
  var nameParts = (lead.name || "").trim().split(/\s+/);
  var firstName = nameParts[0] || lead.name || "";
  var lastName  = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";

  var props = { email: lead.email };
  if (firstName) props.firstname = firstName;
  if (lastName)  props.lastname  = lastName;
  if (lead.company) props.company = lead.company;

  try {
    var resp = UrlFetchApp.fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + CONFIG.HUBSPOT_TOKEN },
      payload: JSON.stringify({ properties: props }),
      muteHttpExceptions: true
    });
    var json = JSON.parse(resp.getContentText());
    if (json.id) {
      Logger.log("HubSpot contact created: " + json.id + " (" + lead.email + ")");
      return json.id;
    }
    Logger.log("HubSpot contact creation failed: " + resp.getContentText());
  } catch (e) {
    Logger.log("HubSpot contact creation error: " + e);
  }
  return null;
}

// Associates a contact with a deal using the v3 associations API.
function _associateContactToDeal_(dealId, contactId) {
  try {
    var resp = UrlFetchApp.fetch(
      "https://api.hubapi.com/crm/v3/objects/deals/" + dealId + "/associations/contacts/" + contactId + "/3",
      {
        method: "put",
        headers: { Authorization: "Bearer " + CONFIG.HUBSPOT_TOKEN },
        muteHttpExceptions: true
      }
    );
    Logger.log("HubSpot contact-deal association (" + contactId + " -> " + dealId + "): " + resp.getResponseCode());
  } catch (e) {
    Logger.log("HubSpot association error: " + e);
  }
}

function createHubspotDeal(lead) {
  if (!CONFIG.HUBSPOT_TOKEN) { Logger.log("HubSpot: no token configured, skipping"); return null; }

  var brand   = lead.brand || DEFAULT_BRAND;
  var initial = HUBSPOT_BRAND_INITIALS[brand] || brand.charAt(0).toUpperCase();
  var dealName = "[" + initial + "] " + (lead.name || "Unknown") + " - " + (lead.service || "General Inquiry") + " [AI]";

  var ownerId = _getHubspotOwnerId_();

  var dealProperties = {
    dealname:  dealName,
    pipeline:  CONFIG.HUBSPOT_PIPELINE_ID,
    dealstage: CONFIG.HUBSPOT_STAGE_NEW_LEAD
  };
  if (ownerId) dealProperties.hubspot_owner_id = ownerId;

  var dealId = null;
  try {
    var resp = UrlFetchApp.fetch("https://api.hubapi.com/crm/v3/objects/deals", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + CONFIG.HUBSPOT_TOKEN },
      payload: JSON.stringify({ properties: dealProperties }),
      muteHttpExceptions: true
    });

    var json = JSON.parse(resp.getContentText());
    if (json.id) {
      dealId = json.id;
      Logger.log("HubSpot deal created: " + dealId + " (" + dealName + ")");
    } else {
      Logger.log("HubSpot deal creation failed: " + resp.getContentText());
      return null;
    }
  } catch (e) {
    Logger.log("HubSpot deal creation error: " + e);
    return null;
  }

  // Attach contact to the deal
  if (lead.email) {
    var contactId = _findHubspotContact_(lead.email);
    if (!contactId) {
      contactId = _createHubspotContact_(lead);
    } else {
      Logger.log("HubSpot: existing contact found: " + contactId + " (" + lead.email + ")");
    }
    if (contactId) {
      _associateContactToDeal_(dealId, contactId);
    }
  }

  return dealId;
}

function moveHubspotDealStage(dealId, stageId) {
  if (!CONFIG.HUBSPOT_TOKEN || !dealId || !stageId) return;

  try {
    var resp = UrlFetchApp.fetch("https://api.hubapi.com/crm/v3/objects/deals/" + dealId, {
      method: "patch",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + CONFIG.HUBSPOT_TOKEN },
      payload: JSON.stringify({ properties: { dealstage: stageId } }),
      muteHttpExceptions: true
    });
    Logger.log("HubSpot stage move (" + dealId + " -> " + stageId + "): " + resp.getResponseCode());
  } catch (e) {
    Logger.log("HubSpot stage move error: " + e);
  }
}

// Returns the current dealstage id for a deal, or null on failure.
function getHubspotDealStage(dealId) {
  if (!CONFIG.HUBSPOT_TOKEN || !dealId) return null;
  try {
    var resp = UrlFetchApp.fetch(
      "https://api.hubapi.com/crm/v3/objects/deals/" + dealId + "?properties=dealstage",
      {
        headers: { Authorization: "Bearer " + CONFIG.HUBSPOT_TOKEN },
        muteHttpExceptions: true
      }
    );
    var json = JSON.parse(resp.getContentText());
    return (json.properties && json.properties.dealstage) || null;
  } catch (e) {
    Logger.log("HubSpot getStage error: " + e);
    return null;
  }
}

// Stage ordering used to ensure Sarah only moves deals FORWARD, never backwards.
// Stages Sarah never touches (pre_proposal, proposal_present, verbal+) are included
// only so the ordering check works correctly — they will never be passed as targetStage.
var HUBSPOT_STAGE_ORDER = [
  CONFIG.HUBSPOT_STAGE_NEW_LEAD,          // 1
  CONFIG.HUBSPOT_STAGE_FOLLOWUP,          // 2
  CONFIG.HUBSPOT_STAGE_INTRO_MEETING,     // 3
  CONFIG.HUBSPOT_STAGE_PRE_PROPOSAL,      // 4  (FYI only)
  CONFIG.HUBSPOT_STAGE_CREATE_PROPOSAL,   // 5
  CONFIG.HUBSPOT_STAGE_PROPOSAL_PRESENT,  // 6  (FYI only)
  CONFIG.HUBSPOT_STAGE_PROPOSAL_SENT,     // 7
  CONFIG.HUBSPOT_STAGE_FOLLOWUP_PROPOSAL, // 8
  CONFIG.HUBSPOT_STAGE_NEGOTIATION,       // 9
  CONFIG.HUBSPOT_STAGE_VERBAL            // 10+ — Sarah never moves here
];

// Moves a deal to targetStage only if targetStage is further along the pipeline
// than the deal's current stage. Skips silently if already at or beyond target.
// Returns true if a move was made, false otherwise.
function advanceHubspotDealStage(dealId, targetStage) {
  if (!dealId || !targetStage) return false;

  var current = getHubspotDealStage(dealId);
  if (!current) {
    Logger.log("HubSpot advanceStage: could not read current stage for deal " + dealId);
    return false;
  }

  var currentIdx = HUBSPOT_STAGE_ORDER.indexOf(current);
  var targetIdx  = HUBSPOT_STAGE_ORDER.indexOf(targetStage);

  if (currentIdx === -1 || targetIdx === -1) {
    // Unknown stage — log and skip rather than blindly moving
    Logger.log("HubSpot advanceStage: unknown stage id. current=" + current + " target=" + targetStage);
    return false;
  }

  if (targetIdx <= currentIdx) {
    Logger.log("HubSpot advanceStage: deal " + dealId + " already at or beyond target (" + current + " >= " + targetStage + "), skipping");
    return false;
  }

  moveHubspotDealStage(dealId, targetStage);
  Logger.log("HubSpot advanceStage: moved deal " + dealId + " from " + current + " to " + targetStage);
  return true;
}

// Maps the signal names Claude returns from the hubspot_advance_stage tool
// to actual stage IDs.  Signals Sarah is allowed to act on are listed here;
// any signal not in this map is ignored so Sarah can never accidentally move
// a deal to verbal/won/lost/etc.
var HUBSPOT_SIGNAL_MAP = {
  "create_proposal":   CONFIG.HUBSPOT_STAGE_CREATE_PROPOSAL,
  "proposal_sent":     CONFIG.HUBSPOT_STAGE_PROPOSAL_SENT,
  "followup_proposal": CONFIG.HUBSPOT_STAGE_FOLLOWUP_PROPOSAL,
  "negotiation":       CONFIG.HUBSPOT_STAGE_NEGOTIATION
};
