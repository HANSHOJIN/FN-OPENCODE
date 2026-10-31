// The SDK still receives an SSE Response and validates the real server.connected
// event. Only the HTTP transport changes; no synthetic connected/model events.
export async function relayEvents(request, fetcher, endpoint) {
  if (request.signal.aborted) throw request.signal.reason ?? new DOMException('Event request canceled', 'AbortError')
  let stream, cursor = 0, stopped = false, controller
  const abort = new AbortController()
  const stop = () => {stopped = true; abort.abort(request.signal.reason)}
  if (request.signal.aborted) stop()
  else request.signal.addEventListener('abort', stop, {once:true})
  async function poll() {
    const url = new URL(endpoint)
    url.searchParams.set('after', String(cursor))
    if (stream) url.searchParams.set('stream', stream)
    const headers = new Headers(request.headers)
    headers.set('accept', 'application/json')
    const response = await fetcher(url.href, {method:'GET',headers,credentials:request.credentials,cache:'no-store',signal:abort.signal})
    if (!response.ok) throw new Error('Event relay HTTP ' + response.status)
    const data = await response.json()
    if (abort.signal.aborted) throw abort.signal.reason ?? new DOMException('Event request canceled', 'AbortError')
    if (!data || typeof data.stream !== 'string' || !/^[a-f0-9]{32}$/.test(data.stream) || (stream && stream !== data.stream) || !Array.isArray(data.chunks) || !Number.isSafeInteger(data.cursor)) throw new Error('Invalid event relay response')
    let next = cursor
    const chunks = []
    for (const item of data.chunks) {
      if (item.seq !== next + 1 || typeof item.data !== 'string') throw new Error('Event sequence gap; reconnect required')
      const decoded = atob(item.data)
      chunks.push(Uint8Array.from(decoded, char => char.charCodeAt(0)))
      next = item.seq
    }
    if (next !== data.cursor) throw new Error('Event cursor mismatch')
    stream = data.stream; cursor = next
    return chunks
  }
  let initial
  try {
    initial = await poll()
    if (abort.signal.aborted) throw abort.signal.reason ?? new DOMException('Event request canceled', 'AbortError')
  }
  catch (error) {stop(); request.signal.removeEventListener('abort', stop); throw error}
  const body = new ReadableStream({
    start(value) {controller = value; for (const chunk of initial) controller.enqueue(chunk)},
    async pull() {
      if (stopped) return
      try {
        while (!stopped) {
          const chunks = await poll()
          if (!chunks.length) continue
          for (const chunk of chunks) if (!stopped) controller.enqueue(chunk)
          return
        }
      }
      catch (error) {
        if (!stopped) {stopped = true; controller.error(error)}
        request.signal.removeEventListener('abort', stop)
      }
    },
    cancel() {stop(); request.signal.removeEventListener('abort', stop)},
  })
  // Cancel an active read as well as any in-flight finite request on navigation.
  request.signal.addEventListener('abort', () => {try {controller.error(request.signal.reason)} catch {}}, {once:true})
  return new Response(body, {status:200,headers:{'Content-Type':'text/event-stream'}})
}
