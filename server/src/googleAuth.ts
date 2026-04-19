import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

const getOAuth2Client = (): OAuth2Client => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const rootUrl = process.env.SERVER_ROOT_URL;

  if (!clientId || !clientSecret || !rootUrl) {
    throw new Error('Missing Google OAuth configuration in environment variables.');
  }

  return new google.auth.OAuth2(clientId, clientSecret, `${rootUrl}/api/auth/callback`);
};

export const getAuthUrl = (): string => {
  const oAuth2Client = getOAuth2Client();
  return oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });
};

export const exchangeCodeForTokens = async (code: string) => {
  const oAuth2Client = getOAuth2Client();
  const { tokens } = await oAuth2Client.getToken(code);
  return tokens;
};

export const buildAuthorizedClient = (tokens: any): OAuth2Client => {
  const oAuth2Client = getOAuth2Client();
  oAuth2Client.setCredentials(tokens);
  return oAuth2Client;
};
