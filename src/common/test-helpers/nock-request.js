/**
 * Reads the request nock 15 hands a reply function: its path and query, method,
 * lower-cased headers, and body (parsed when it is JSON or a form).
 * @param {Request} request
 * @returns {Promise<{uri: string, method: string, headers: Record<string, string>, body: any}>}
 */
export async function readRequest(request) {
  const url = new URL(request.url)
  const text = await request.clone().text()
  const headers = Object.fromEntries(request.headers.entries())

  return {
    uri: `${url.pathname}${url.search}`,
    method: request.method,
    headers,
    body: parseBody(text, headers['content-type'] ?? '')
  }
}

function parseBody(text, contentType) {
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text))
  }

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
