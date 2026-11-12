/**
 * Pure helpers for the V3.1 script-cache of compiled read-only boot payloads.
 * CacheService I/O lives in Code.js; these functions have no Google APIs so
 * the keying, size cap, and generation-bust rules can be unit-tested.
 *
 * SECURITY: the cache key always includes role + the authenticated email +
 * the calendar day. Code.js must verify the ID token and resolve the user
 * from Portal_Users BEFORE any cache read. Keys are never taken from the
 * request body.
 */
var DoorwayBootCache = (function () {
  var TTL_SEC = 180;
  var MAX_CHARS = 90000; // stay under CacheService's 100 KB value limit
  var GEN_KEY = 'boot_gen';
  var GEN_TTL_SEC = 21600;

  function key(gen, role, email, today) {
    var r = String(role || '').trim();
    var e = String(email || '').trim().toLowerCase();
    var d = String(today || '');
    var g = String(gen == null || gen === '' ? '0' : gen);
    return 'boot_' + g + '_' + r + '_' + e + '_' + d;
  }

  function nextGen(current) {
    var n = parseInt(current || '0', 10);
    if (!isFinite(n) || n < 0) n = 0;
    return String((n + 1) % 1000000);
  }

  function canStore(jsonText) {
    return typeof jsonText === 'string' && jsonText.length > 0 && jsonText.length <= MAX_CHARS;
  }

  /** Defense in depth: refuse a cached payload that does not match the already-authenticated user. */
  function accept(obj, user) {
    if (!obj || typeof obj !== 'object' || obj.status !== 200) return null;
    if (!user || obj.role !== user.role) return null;
    var email = user.email ? String(user.email).toLowerCase() : '';
    if (!email || !obj.me || String(obj.me.email || '').toLowerCase() !== email) return null;
    if (user.role !== 'Owner' && Object.prototype.hasOwnProperty.call(obj, 'queue')) {
      var copy = {};
      for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k) && k !== 'queue') copy[k] = obj[k];
      return copy;
    }
    return obj;
  }

  return {
    TTL_SEC: TTL_SEC,
    MAX_CHARS: MAX_CHARS,
    GEN_KEY: GEN_KEY,
    GEN_TTL_SEC: GEN_TTL_SEC,
    key: key,
    nextGen: nextGen,
    canStore: canStore,
    accept: accept
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DoorwayBootCache;
