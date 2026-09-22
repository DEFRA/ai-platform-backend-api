export const health = {
  method: 'GET',
  path: '/health',
  handler: (_request, h) => h.response({ status: 'ok' })
}
