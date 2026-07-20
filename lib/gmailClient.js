/**
 * Thin Gmail/Google API wrappers — injectable for tests.
 * Never log tokens, codes, or client secrets.
 */

const { google } = require('googleapis');

const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const USERINFO_EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
const OPENID_SCOPE = 'openid';

const GMAIL_OAUTH_SCOPES = [GMAIL_READONLY_SCOPE, USERINFO_EMAIL_SCOPE, OPENID_SCOPE];

/**
 * @param {{ clientId: string, clientSecret: string, redirectUri: string }} config
 */
function createGmailOAuth2Client(config) {
  return new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
}

/**
 * Default Google API adapter used in production.
 * All methods are overridable via setGmailApiAdapter in tests.
 */
function createDefaultGmailApiAdapter() {
  return {
    /**
     * @param {import('google-auth-library').OAuth2Client} oauth2Client
     * @param {string} code
     */
    async exchangeCode(oauth2Client, code) {
      const { tokens } = await oauth2Client.getToken(code);
      return tokens;
    },

    /**
     * @param {import('google-auth-library').OAuth2Client} oauth2Client
     */
    async getProfile(oauth2Client) {
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const res = await oauth2.userinfo.get();
      return {
        id: res.data.id || null,
        email: res.data.email || null,
        name: res.data.name || null,
      };
    },

    /**
     * @param {import('google-auth-library').OAuth2Client} oauth2Client
     */
    async refreshAccessToken(oauth2Client) {
      const { credentials } = await oauth2Client.refreshAccessToken();
      return credentials;
    },

    /**
     * @param {import('google-auth-library').OAuth2Client} oauth2Client
     * @param {{ maxResults?: number, pageToken?: string, q?: string }} opts
     */
    async listMessages(oauth2Client, opts = {}) {
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      const res = await gmail.users.messages.list({
        userId: 'me',
        maxResults: opts.maxResults ?? 50,
        pageToken: opts.pageToken,
        q: opts.q ?? '-in:spam -in:trash',
      });
      return {
        messages: (res.data.messages || []).map((m) => ({ id: m.id, threadId: m.threadId })),
        nextPageToken: res.data.nextPageToken || null,
        resultSizeEstimate: res.data.resultSizeEstimate ?? 0,
      };
    },

    /**
     * @param {import('google-auth-library').OAuth2Client} oauth2Client
     * @param {string} messageId
     */
    async getMessage(oauth2Client, messageId) {
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      const res = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });
      return res.data;
    },

    /**
     * @param {import('google-auth-library').OAuth2Client} oauth2Client
     */
    async getProfileHistoryId(oauth2Client) {
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      const res = await gmail.users.getProfile({ userId: 'me' });
      return {
        emailAddress: res.data.emailAddress || null,
        historyId: res.data.historyId ? String(res.data.historyId) : null,
        messagesTotal: res.data.messagesTotal ?? 0,
      };
    },

    /**
     * @param {import('google-auth-library').OAuth2Client} oauth2Client
     * @param {string} startHistoryId
     */
    async listHistory(oauth2Client, startHistoryId) {
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      const messageIds = new Set();
      let pageToken;
      let latestHistoryId = startHistoryId;

      do {
        const res = await gmail.users.history.list({
          userId: 'me',
          startHistoryId,
          historyTypes: ['messageAdded'],
          pageToken,
        });
        if (res.data.historyId) {
          latestHistoryId = String(res.data.historyId);
        }
        for (const entry of res.data.history || []) {
          for (const added of entry.messagesAdded || []) {
            if (added.message?.id) {
              messageIds.add(added.message.id);
            }
          }
        }
        pageToken = res.data.nextPageToken || undefined;
      } while (pageToken);

      return {
        messageIds: [...messageIds],
        historyId: latestHistoryId,
      };
    },
  };
}

/** @type {ReturnType<typeof createDefaultGmailApiAdapter>} */
let gmailApiAdapter = createDefaultGmailApiAdapter();

/**
 * @param {ReturnType<typeof createDefaultGmailApiAdapter>} adapter
 */
function setGmailApiAdapter(adapter) {
  gmailApiAdapter = adapter;
}

function resetGmailApiAdapter() {
  gmailApiAdapter = createDefaultGmailApiAdapter();
}

function getGmailApiAdapter() {
  return gmailApiAdapter;
}

module.exports = {
  GMAIL_READONLY_SCOPE,
  USERINFO_EMAIL_SCOPE,
  OPENID_SCOPE,
  GMAIL_OAUTH_SCOPES,
  createGmailOAuth2Client,
  createDefaultGmailApiAdapter,
  setGmailApiAdapter,
  resetGmailApiAdapter,
  getGmailApiAdapter,
};
