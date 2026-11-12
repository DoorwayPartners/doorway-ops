/**
 * Public, non-secret configuration. Both values are safe to publish:
 * an OAuth *client ID* is public by design (it is not the client secret),
 * and the Apps Script URL is useless without a valid Google ID token for
 * an email listed in Portal_Users.
 */
window.DOORWAY_CONFIG = {
  GOOGLE_CLIENT_ID: 'REPLACE_WITH_OAUTH_CLIENT_ID.apps.googleusercontent.com',
  API_URL: 'REPLACE_WITH_APPS_SCRIPT_WEB_APP_URL'
};
