// Fields this app adds to Express requests (type checking only: npm run typecheck)
declare global {
  namespace Express {
    interface Request {
      /** The signed-in user (auth.mjs), or null */
      user: any;
      /** Session id of the signed-in user (auth.mjs) */
      sessionId?: string;
      /** Files accepted by the upload middleware (files.mjs) */
      uploads?: any;
      /** The JSON "data" field of a multipart upload (files.mjs) */
      data?: any;
    }
  }
}
export {};
