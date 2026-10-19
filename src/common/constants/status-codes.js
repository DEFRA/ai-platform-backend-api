/**
 * Named HTTP status codes, so responses and upstream checks read by meaning
 * rather than by number. Add a code here when it is first needed.
 */
export const statusCodes = {
  ok: 200,
  accepted: 202,
  notModified: 304,
  forbidden: 403,
  notFound: 404,
  tooManyRequests: 429
}
