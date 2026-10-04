export interface Plan {
  hold: {path: string; bytes: number; held: string}[]
  hold_bytes: number
  hold_until: number
  final: string[]
  final_bytes: number
  final_count: number
  rejected: {reason: string; path: string}[]
  count: number
  bytes: number
}

export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface Selected {
  add: string
  drop: string
  listed: number | null
  fingerprint: string
}

interface RequestError extends Error {
  kind: 'server' | 'unreachable'
  url: string
  status: number
  text: string
}

function requestError(fields: Omit<RequestError, 'name' | 'message'>, message: string): RequestError {
  return Object.assign(new Error(message), {name: 'RequestError', ...fields})
}

async function send(url: string, payload: string) {
  try {
    return await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: payload})
  } catch (cause) {
    throw requestError({kind: 'unreachable', url, status: 0, text: String(cause)}, `Can't reach disk-clean (${url}). Is it still running in the terminal?`)
  }
}

async function post(url: string, payload: string) {
  const response = await send(url, payload)
  if (!response.ok) {
    const text = (await response.text().catch(() => '')).trim()
    throw requestError({kind: 'server', url, status: response.status, text}, `disk-clean answered ${response.status} to ${url}${text ? `: ${text}` : ''}`)
  }
  return response.json()
}

export function preview(token: string, selected: Selected): Promise<Plan> {
  return post('/preview', JSON.stringify({token, ...selected}))
}

export function rescan(token: string) {
  return post('/rescan', JSON.stringify({token}))
}

export function decide(token: string, decision: 'approve' | 'cancel', selected?: Selected) {
  return post('/decide', JSON.stringify({token, decision, ...selected}))
}

export function heldAction(token: string, action: 'undo' | 'free') {
  return post(`/${action}`, JSON.stringify({token}))
}
