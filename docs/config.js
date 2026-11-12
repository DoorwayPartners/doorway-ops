/**
 * Public, non-secret configuration. Both values are safe to publish:
 * an OAuth *client ID* is public by design (it is not the client secret),
 * and the Apps Script URL is useless without a valid Google ID token for
 * an email listed in Portal_Users.
 */
window.DOORWAY_CONFIG = {
  GOOGLE_CLIENT_ID: '814837808847-h1g51clfsdojj30ar0getbrskrpsb5cu.apps.googleusercontent.com',
  API_URL: 'https://script.google.com/macros/s/AKfycbzlmCKst9Z33ITESqLkac_lxP_l5vlROhDJF_krOQP-uJM1MK1M6crqV71qs-iLpoDxJg/exec'
};
