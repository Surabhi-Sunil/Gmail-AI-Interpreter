import 'express-session';

declare module 'express-session' {
  interface SessionData {
    tokens?: import('google-auth-library').Credentials;
    user?: {
      id: number;
      name: string;
      email: string;
    };
  }
}
