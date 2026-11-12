/**
 * Doorway Ops V3.3 — Module 3: cross-channel entity linker (apps-script/EntityLinker.js).
 *
 * Links incoming email text to an Order (by Order ID or normalized street)
 * or a Rep (by name) before a row is staged on Ops_Approval_Queue.
 * Matching may use Service_Address internally; the returned object never
 * includes addresses, customer names, margins, or pay fields. The intake
 * hook must never send mail or mark messages read.
 */
var DoorwayEntity = (function () {
  function normalizeStreet(addr) {
    return String(addr || '').toLowerCase()
      .replace(/\bstreet\b/g, 'st').replace(/\broad\b/g, 'rd')
      .replace(/\bavenue\b/g, 'ave').replace(/\bdrive\b/g, 'dr')
      .replace(/[^a-z0-9]/g, '');
  }

  function slimOrder(o) {
    if (!o) return null;
    return {
      Order_ID: String(o.Order_ID || ''),
      C2C_Status: String(o.C2C_Status || ''),
      Rep_Name: String(o.Rep_Name || '')
    };
  }
  function slimRep(r) {
    if (!r) return null;
    var name = String(r.Rep_Name || r.Name || '').trim();
    return name ? { Rep_Name: name } : null;
  }

  function enrichEntityContext(rawText, orders, roster) {
    var text = String(rawText || '');
    var orderMatch = text.match(/\b(26\d{4}[A-Za-z0-9]{2,6}|DEMO-\d+)\b/i);
    var matchedOrder = null;

    if (orderMatch && orders) {
      var targetId = orderMatch[1].toUpperCase();
      matchedOrder = orders.filter(function (o) {
        return String(o.Order_ID || '').toUpperCase() === targetId;
      })[0] || null;
    }

    if (!matchedOrder && orders) {
      var normText = normalizeStreet(text);
      matchedOrder = orders.filter(function (o) {
        var full = String(o.Service_Address || '');
        var keys = [normalizeStreet(full), normalizeStreet(full.split(',')[0])];
        return keys.some(function (s) { return s.length >= 8 && normText.indexOf(s) !== -1; });
      })[0] || null;
    }

    var matchedRep = null;
    if (roster) {
      var lower = text.toLowerCase();
      matchedRep = roster.filter(function (r) {
        var n = String(r.Rep_Name || r.Name || '').trim().toLowerCase();
        return n.length >= 4 && lower.indexOf(n) !== -1;
      })[0] || null;
    }

    var order = slimOrder(matchedOrder);
    var rep = slimRep(matchedRep);
    return {
      linkedOrder: order,
      linkedRep: rep,
      summaryTag: order ? ('Order ' + order.Order_ID + ' (' + (order.C2C_Status || 'Active') + ')') :
                  (rep ? ('Rep: ' + rep.Rep_Name) : 'Unlinked Intake')
    };
  }

  return {
    normalizeStreet: normalizeStreet,
    enrichEntityContext: enrichEntityContext,
    slimOrder: slimOrder,
    slimRep: slimRep
  };
})();

function normalizeStreet_(addr) { return DoorwayEntity.normalizeStreet(addr); }

function enrichEntityContext(rawText, orders, roster) {
  return DoorwayEntity.enrichEntityContext(rawText, orders, roster);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DoorwayEntity;
}
