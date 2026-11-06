/**
 * Named HTTP status codes, so responses and upstream checks read by meaning
 * rather than by number. Add a code here when it is first needed.
 */
export const statusCodes = {
  ok: 200,
  created: 201,
  accepted: 202,
  noContent: 204,
  notModified: 304,
  unauthorised: 401,
  forbidden: 403,
  notFound: 404,
  tooManyRequests: 429,
  internalServerError: 500
}
